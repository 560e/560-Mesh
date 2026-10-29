#!/usr/bin/env python3
"""Private, maintenance-window snapshots for the hs560 Compose deployment.

Only the Python standard library is used. This tool intentionally refuses
cross-release restores; use the matching release checkout and image first.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid


ROOTS = ("config/headscale", "config/headplane", "data/headscale", "data/headplane")
REQUIRED = ("config/headscale/config.yaml", "config/headplane/config.yaml")
MAX_FILE_SIZE = 8 * 1024**3
MAX_TOTAL_SIZE = 64 * 1024**3
MAX_ARCHIVE_SIZE = 64 * 1024**3
MAX_MEMBERS = 100_000
MAX_MANIFEST_SIZE = 1024**2
COPY_CHUNK = 1024**2


class OperationError(RuntimeError):
    """An operation was refused or could not complete safely."""


class _BoundedTarInfo(tarfile.TarInfo):
    """Bound extension headers before tarfile allocates/parses their payload.

    The normal iterator hides PAX/GNU extension headers, so limits on yielded
    members alone would miss oversized metadata and sparse-map allocations.
    """
    def _proc_member(self, archive):
        archive._ops_headers = getattr(archive, "_ops_headers", 0) + 1
        if archive._ops_headers > MAX_MEMBERS:
            raise OperationError("Archive exceeds total header count limit")
        extensions = (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.SOLARIS_XHDTYPE, tarfile.GNUTYPE_LONGNAME)
        if self.type in extensions:
            archive._ops_extension_bytes = getattr(archive, "_ops_extension_bytes", 0) + self.size
            depth = getattr(archive, "_ops_extension_depth", 0) + 1
            if self.size < 0 or self.size > 65536 or archive._ops_extension_bytes > 8 * 1024**2 or depth > 8:
                raise OperationError("Archive extension metadata exceeds safety limit")
            position = archive.fileobj.tell()
            payload = archive.fileobj.read(self.size)
            archive.fileobj.seek(position)
            if b"GNU.sparse" in payload or b"SCHILY.realsize" in payload:
                raise OperationError("Sparse archive metadata is forbidden")
            archive._ops_extension_depth = depth
            try:
                return super()._proc_member(archive)
            finally:
                archive._ops_extension_depth -= 1
        if self.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE):
            raise OperationError("Links, sparse and special archive headers are forbidden")
        return super()._proc_member(archive)


def _plain_path(path: Path, *, missing: bool = False) -> None:
    """Reject links, Windows junctions and reparse points in every ancestor."""
    for part in reversed((path, *path.parents)):
        try:
            info = part.lstat()
        except FileNotFoundError:
            if missing:
                continue
            raise OperationError(f"Required path is missing: {part}") from None
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise OperationError(f"Links/reparse points are forbidden: {part}")


def _regular_info(path: Path):
    _plain_path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise OperationError(f"Expected a regular, non-hardlinked file: {path}")
    return info


@contextmanager
def _open_regular(path: Path):
    _regular_info(path)
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise OperationError(f"File changed type while opening: {path}")
        yield stream


def _read_json(path: Path):
    with _open_regular(path) as stream:
        content = stream.read(MAX_MANIFEST_SIZE + 1)
    if len(content) > MAX_MANIFEST_SIZE:
        raise OperationError(f"Metadata is too large: {path}")
    try:
        return json.loads(content)
    except (ValueError, UnicodeError) as error:
        raise OperationError(f"Invalid JSON metadata: {path}") from error


class ComposeController:
    """The sole subprocess boundary; every invocation has a fixed argv/cwd."""
    def __init__(self, root: Path):
        self.root = root
        # Explicit file/directory defeat COMPOSE_FILE pointing at a different
        # deployment. Normal COMPOSE_PROJECT_NAME handling remains consistent
        # with the other scripts, including isolated restore rehearsals.
        self.base = ["docker", "compose", "--project-directory", str(root),
                     "--file", str(root / "docker-compose.yml")]

    def _run(self, argv):
        try:
            environment = dict(os.environ)
            if (self.root / ".docker/config.json").is_file():
                environment["DOCKER_CONFIG"] = str(self.root / ".docker")
            result = subprocess.run(argv, cwd=self.root, env=environment, check=True, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
        except (OSError, subprocess.SubprocessError) as error:
            # Compose output can contain interpolated secrets. Do not echo it.
            raise OperationError(f"Docker command failed ({argv[0:2]}): {type(error).__name__}") from error
        return result.stdout

    def _container(self):
        ids = self._run([*self.base, "ps", "--all", "--quiet", "platform"]).split()
        if len(ids) > 1:
            raise OperationError("Expected at most one platform container")
        if not ids:
            return None
        try:
            return json.loads(self._run(["docker", "inspect", ids[0]]))[0]
        except (ValueError, IndexError, KeyError) as error:
            raise OperationError("Invalid Docker inspect result") from error

    def is_running(self):
        container = self._container()
        if container is None:
            return False
        state = container["State"]
        if state.get("Paused") or state.get("Restarting") or state.get("Dead"):
            raise OperationError("Platform must be running normally or fully stopped")
        return bool(state["Running"])

    def metadata(self):
        try:
            config = json.loads(self._run([*self.base, "config", "--format", "json"]))
            if set(config["services"]) != {"platform"}:
                raise OperationError("Expected the single platform Compose service")
            image = config["services"]["platform"]["image"]
            container = self._container()
            if container is not None:
                self._validate_scope(container, config.get("name", "hs560"))
            if container is not None and container["Config"]["Image"] != image:
                raise OperationError("Existing container image differs from Compose; reconcile the release first")
            image_id = self._run(["docker", "image", "inspect", image, "--format", "{{.Id}}"]).strip()
            if not image_id:
                raise OperationError("The configured platform image is not available locally")
            if container is not None and container["Image"] != image_id:
                raise OperationError("Existing container uses an older image ID; reconcile the release first")
            return {"image": image, "image_id": image_id}
        except (ValueError, KeyError, TypeError) as error:
            raise OperationError("Cannot determine the platform image from Compose") from error

    def _validate_scope(self, container, project_name):
        def normalized(value):
            return os.path.normcase(os.path.abspath(value))
        labels = container["Config"].get("Labels") or {}
        if (labels.get("com.docker.compose.project") != project_name
                or labels.get("com.docker.compose.service") != "platform"
                or normalized(labels.get("com.docker.compose.project.working_dir", "")) != normalized(self.root)
                or labels.get("com.docker.compose.project.config_files") != str(self.root / "docker-compose.yml")):
            raise OperationError("Container belongs to a different Compose deployment; no service will be stopped")
        destinations = ("/etc/headscale", "/etc/headplane", "/var/lib/headscale", "/var/lib/headplane")
        for name, destination in zip(ROOTS, destinations):
            matches = [mount for mount in container.get("Mounts", []) if mount.get("Destination") == destination]
            if (len(matches) != 1 or matches[0].get("Type") != "bind"
                    or normalized(matches[0].get("Source", "")) != normalized(self.root / name)
                    or matches[0].get("RW") is not name.startswith("data/")):
                raise OperationError(f"Container mount does not match this checkout: {destination}; operation refused")

    def stop(self):
        self._run([*self.base, "stop", "--timeout", "60", "platform"])
        if self.is_running():
            raise OperationError("Platform did not stop; snapshot refused")

    def start(self):
        # start preserves the exact existing container/image and never pulls or builds.
        self._run([*self.base, "start", "platform"])
        if not self.is_running():
            raise OperationError("Platform did not restart; inspect it before continuing")


class Operations:
    def __init__(self, root, controller=None):
        self.root = Path(root).absolute()
        _plain_path(self.root)
        self.backups = self.root / "backups"
        self.controller = controller if controller is not None else ComposeController(self.root)

    @contextmanager
    def _locked(self):
        _plain_path(self.backups, missing=True)
        self.backups.mkdir(mode=0o700, exist_ok=True)
        if not self.backups.is_dir():
            raise OperationError("backups must be a private directory")
        self.backups.chmod(0o700)
        lock = self.backups / ".operations.lock"
        try:
            lock.mkdir(mode=0o700)
        except FileExistsError:
            raise OperationError("Another operation or stale lock exists: backups/.operations.lock") from None
        try:
            yield
        finally:
            lock.rmdir()

    def _identity(self):
        package = _read_json(self.root / "package.json")
        sources = _read_json(self.root / "sources.lock.json")
        try:
            if not isinstance(package["version"], str) or not package["version"]:
                raise ValueError("missing platform version")
            for name in ("headscale", "headplane"):
                if not all(isinstance(sources[name][key], str) and sources[name][key]
                           for key in ("version", "commit")):
                    raise ValueError("missing component pin")
        except (KeyError, TypeError, ValueError) as error:
            raise OperationError("Project package/source version pins are incomplete") from error
        metadata = self.controller.metadata()
        if not isinstance(metadata.get("image"), str) or not metadata["image"]:
            raise OperationError("Platform image is missing")
        return {"platform_version": package["version"], "sources": sources, **metadata}

    def _source_members(self):
        members = []
        total = 0
        for name in ROOTS:
            source = self.root / name
            _plain_path(source)
            if not source.is_dir():
                raise OperationError(f"Required runtime directory is missing: {source}")
            pending = [source]
            while pending:
                path = pending.pop()
                _plain_path(path)
                info = path.lstat()
                if stat.S_ISDIR(info.st_mode):
                    pending.extend(sorted(path.iterdir(), reverse=True))
                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                    if info.st_size > MAX_FILE_SIZE:
                        raise OperationError(f"File exceeds snapshot limit: {path}")
                    total += info.st_size
                else:
                    raise OperationError(f"Links, hardlinks and special files are forbidden: {path}")
                if len(members) >= MAX_MEMBERS - 1 or total > MAX_TOTAL_SIZE:
                    raise OperationError("Snapshot exceeds member/total size limit")
                members.append(path)
        for name in REQUIRED:
            _regular_info(self.root / name)
        return members

    def _snapshot(self, identity, prefix="backup"):
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        archive = self.backups / f"{prefix}-{stamp}-{uuid.uuid4().hex[:8]}.tar.gz"
        temporary = archive.with_name(archive.name + ".partial")
        sidecar = Path(str(archive) + ".sha256")
        try:
            paths = self._source_members()
            manifest = {"format": 1, "created_at": stamp, "project": "hs560", "service": "platform",
                        "roots": list(ROOTS), **identity}
            payload = json.dumps(manifest, sort_keys=True, indent=2).encode("utf-8")
            with temporary.open("xb") as raw:
                temporary.chmod(0o600)
                with tarfile.open(fileobj=raw, mode="w:gz", dereference=True) as saved:
                    item = tarfile.TarInfo("manifest.json")
                    item.size, item.mode = len(payload), 0o600
                    saved.addfile(item, io.BytesIO(payload))
                    for path in paths:
                        name = path.relative_to(self.root).as_posix()
                        _plain_path(path)
                        item = saved.gettarinfo(str(path), arcname=name)
                        if item.isdir():
                            saved.addfile(item)
                        elif item.isfile():
                            with _open_regular(path) as stream:
                                saved.addfile(item, stream)
                        else:
                            raise OperationError(f"File changed type during snapshot: {path}")
                raw.flush()
                os.fsync(raw.fileno())
            with temporary.open("rb") as compressed:
                digest = hashlib.file_digest(compressed, "sha256").hexdigest()
            os.replace(temporary, archive)
            with sidecar.open("x", encoding="ascii", newline="\n") as checksum:
                sidecar.chmod(0o600)
                checksum.write(f"{digest}  {archive.name}\n")
                checksum.flush()
                os.fsync(checksum.fileno())
            return archive
        except BaseException:
            for path in (temporary, archive, sidecar):
                path.unlink(missing_ok=True)
            raise

    def backup(self):
        with self._locked():
            identity = self._identity()
            running = self.controller.is_running()
            try:
                if running:
                    self.controller.stop()
                return self._snapshot(identity)
            finally:
                if running:
                    self.controller.start()

    def _copy_checked_archive(self, archive, destination):
        archive = Path(archive).absolute()
        sidecar = Path(str(archive) + ".sha256")
        with _open_regular(sidecar) as checksum:
            raw = checksum.read(4097)
        try:
            expected = raw.decode("ascii").strip()
        except UnicodeError as error:
            raise OperationError("Invalid SHA256 sidecar") from error
        match = re.fullmatch(r"([a-fA-F0-9]{64})  (.+)", expected)
        if len(raw) > 4096 or match is None or match[2] != archive.name:
            raise OperationError("SHA256 sidecar must name this archive")
        digest = hashlib.sha256()
        total = 0
        with _open_regular(archive) as source, destination.open("xb") as target:
            destination.chmod(0o600)
            while chunk := source.read(COPY_CHUNK):
                total += len(chunk)
                if total > MAX_ARCHIVE_SIZE:
                    raise OperationError("Compressed archive exceeds size limit")
                target.write(chunk)
                digest.update(chunk)
        if digest.hexdigest() != match[1].lower():
            raise OperationError("Archive SHA256 mismatch; restore refused")

    @staticmethod
    def _archive_name(item):
        name = item.name
        parts = name.split("/")
        if (not name or len(name) > 4096 or "\\" in name or ":" in name
                or any(ord(char) < 32 for char in name)
                or any(part in ("", ".", "..") or part.endswith((" ", ".")) for part in parts)):
            raise OperationError(f"Unsafe archive path: {name!r}")
        if PurePosixPath(name).is_absolute():
            raise OperationError(f"Absolute archive path: {name!r}")
        # These names alias devices on Windows; rejecting everywhere makes archives portable.
        devices = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
        if any(part.split(".")[0].upper() in devices for part in parts):
            raise OperationError(f"Reserved archive path: {name!r}")
        if name != "manifest.json" and not any(name == root or name.startswith(root + "/") for root in ROOTS):
            raise OperationError(f"Unexpected archive path: {name!r}")
        return name

    def _validate_and_stage(self, archive, incoming, identity):
        seen = {}
        folded = set()
        total = 0
        with tarfile.open(archive, "r:gz", tarinfo=_BoundedTarInfo) as saved:
            for item in saved:
                name = self._archive_name(item)
                if name in seen or name.casefold() in folded:
                    raise OperationError(f"Duplicate/aliased archive member: {name}")
                if not (item.isfile() or item.isdir()) or item.issparse():
                    raise OperationError(f"Links, sparse and special archive members are forbidden: {name}")
                if item.size < 0 or item.size > MAX_FILE_SIZE or (item.isdir() and item.size != 0):
                    raise OperationError(f"Invalid member size: {name}")
                if name == "manifest.json" and (not item.isfile() or item.size > MAX_MANIFEST_SIZE):
                    raise OperationError("Invalid backup manifest")
                total += item.size
                if len(seen) >= MAX_MEMBERS or total > MAX_TOTAL_SIZE:
                    raise OperationError("Archive exceeds member/total size limit")
                seen[name] = item
                folded.add(name.casefold())
            for name in (*ROOTS, *REQUIRED, "manifest.json"):
                if name not in seen:
                    raise OperationError(f"Required archive member is missing: {name}")
            if any(not seen[name].isdir() for name in ROOTS) or any(not seen[name].isfile() for name in REQUIRED):
                raise OperationError("Incorrect root/config member type")
            for name in seen:
                for parent in PurePosixPath(name).parents:
                    if parent.as_posix() in seen and not seen[parent.as_posix()].isdir():
                        raise OperationError(f"Archive file is also a directory: {parent}")
            try:
                manifest = json.load(saved.extractfile(seen["manifest.json"]))
            except (ValueError, UnicodeError) as error:
                raise OperationError("Invalid backup manifest JSON") from error
            if (not isinstance(manifest, dict) or manifest.get("format") != 1
                    or manifest.get("project") != "hs560" or manifest.get("service") != "platform"
                    or manifest.get("roots") != list(ROOTS)):
                raise OperationError("Backup format/deployment does not match")
            for key in ("platform_version", "sources", "image"):
                if manifest.get(key) != identity[key]:
                    raise OperationError(f"Backup {key} differs; use the matching release checkout/image")
            # If available on both sides, require the identical built image too.
            if manifest.get("image_id") and identity.get("image_id") and manifest["image_id"] != identity["image_id"]:
                raise OperationError("Backup image ID differs; load the original image before restoring")
            incoming.mkdir(mode=0o700)
            directories = []
            for name, item in seen.items():
                if name == "manifest.json":
                    continue
                target = incoming / name
                if item.isdir():
                    target.mkdir(mode=0o700, parents=True, exist_ok=True)
                    directories.append((target, item))
                else:
                    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    with saved.extractfile(item) as source, target.open("xb") as output:
                        shutil.copyfileobj(source, output, COPY_CHUNK)
                    if target.stat().st_size != item.size:
                        raise OperationError(f"Truncated archive member: {name}")
                    self._restore_metadata(target, item)
            # Apply directory metadata after children, so read-only dirs can be restored.
            for target, item in sorted(directories, key=lambda pair: len(pair[0].parts), reverse=True):
                self._restore_metadata(target, item)

    @staticmethod
    def _restore_metadata(path, item):
        if os.name != "nt" and os.geteuid() == 0:
            os.chown(path, item.uid, item.gid, follow_symlinks=False)
        path.chmod(item.mode & 0o777)  # never restore setuid/setgid/sticky bits
        if os.utime in os.supports_follow_symlinks:
            os.utime(path, (item.mtime, item.mtime), follow_symlinks=False)
        else:
            # Windows lacks this flag. All staged entries were created privately,
            # and archive links/reparse points are forbidden before this point.
            os.utime(path, (item.mtime, item.mtime))

    def _replace_roots(self, incoming, rollback):
        rollback.mkdir(mode=0o700)
        moved = []
        try:
            for name in ROOTS:
                current, old = self.root / name, rollback / name
                _plain_path(current)
                old.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                os.replace(current, old)
                moved.append(name)
                os.replace(incoming / name, current)
        except BaseException as failure:
            errors = []
            for name in reversed(moved):
                current, old = self.root / name, rollback / name
                try:
                    if current.exists():
                        # Move aside rather than delete until rollback is complete.
                        discard = incoming / name
                        discard.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                        os.replace(current, discard)
                    os.replace(old, current)
                except OSError as error:
                    errors.append(f"{name}: {error}")
            if errors:
                raise OperationError(f"Rollback incomplete. Retain {rollback.parent}; repair manually: {'; '.join(errors)}") from failure
            raise

    def restore(self, archive, *, confirm_restore=False):
        if confirm_restore is not True:
            raise OperationError("Restore replaces runtime config/data; pass --confirm-restore explicitly")
        with self._locked():
            identity = self._identity()
            stage = Path(tempfile.mkdtemp(prefix=".restore-", dir=self.backups))
            retain_stage = False
            try:
                staged_archive = stage / "archive.tar.gz"
                self._copy_checked_archive(archive, staged_archive)
                self._validate_and_stage(staged_archive, stage / "incoming", identity)
                running = self.controller.is_running()
                try:
                    if running:
                        self.controller.stop()
                    previous = self._snapshot(identity, prefix="pre-restore")
                    try:
                        self._replace_roots(stage / "incoming", stage / "rollback")
                    except OperationError as error:
                        if "Rollback incomplete" in str(error):
                            retain_stage = True
                        raise
                    return previous
                finally:
                    if running and not retain_stage:
                        self.controller.start()
            except (tarfile.TarError, EOFError, ValueError) as error:
                raise OperationError(f"Invalid/truncated archive: {error}") from error
            finally:
                if not retain_stage:
                    shutil.rmtree(stage)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2] / "head-docker")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("backup", help="Stop, snapshot all runtime config/data, restore prior running state")
    restore = commands.add_parser("restore", help="Validate, preserve current snapshot, restore exact matching release")
    restore.add_argument("archive", type=Path)
    restore.add_argument("--confirm-restore", action="store_true")
    args = parser.parse_args(argv)
    try:
        operations = Operations(args.root)
        if args.command == "backup":
            print(f"Backup: {operations.backup()}")
        else:
            print(f"Restored. Pre-restore snapshot: {operations.restore(args.archive, confirm_restore=args.confirm_restore)}")
        return 0
    except (OperationError, OSError) as error:
        print(f"Operation failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Filesystem/archive tests. Docker is replaced only at its controller boundary."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace


MODULE = Path(__file__).resolve().parents[1] / "tools" / "operations.py"


class FakeCompose:
    """A single platform container; stopping it flushes a final WAL record."""
    def __init__(self, root, running=True):
        self.root = root
        self.running = running
        self.events = []
        self.fail_stop = False

    def metadata(self):
        return {"image": "560-headscale-platform:1.0.0", "image_id": "sha256:abc"}

    def is_running(self):
        return self.running

    def stop(self):
        self.events.append("stop")
        self.running = False
        (self.root / "data/headscale/db.sqlite-wal").write_bytes(b"flushed-on-stop")
        if self.fail_stop:
            raise RuntimeError("stop failed")

    def start(self):
        self.events.append("start")
        self.running = True


class OperationsTests(unittest.TestCase):
    def setUp(self):
        if not MODULE.exists():
            self.fail("backup/restore operations implementation is missing")
        spec = importlib.util.spec_from_file_location("operations", MODULE)
        self.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mod)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "project"
        self.root.mkdir()
        for directory in ("config/headscale", "config/headplane", "data/headscale", "data/headplane"):
            (self.root / directory).mkdir(parents=True)
        (self.root / "package.json").write_text('{"version":"1.0.0"}')
        (self.root / "sources.lock.json").write_text(json.dumps({
            "headscale": {"version": "0.29.6", "commit": "a" * 40},
            "headplane": {"version": "0.8.2", "commit": "b" * 40},
        }))
        (self.root / "config/headscale/config.yaml").write_bytes(b"noise-key: private")
        (self.root / "config/headplane/config.yaml").write_bytes(b"cookie-secret: private")
        (self.root / "config/headplane/headscale-api.key").write_bytes(b"server-secret")
        (self.root / "data/headscale/db.sqlite").write_bytes(b"database")
        (self.root / "data/headscale/db.sqlite-wal").write_bytes(b"before-stop")
        (self.root / "data/headscale/noise_private.key").write_bytes(b"noise-private-key")
        (self.root / "data/headplane/hp_persist.db").write_bytes(b"admin-and-sessions")
        (self.root / "data/headplane/empty").mkdir()
        self.compose = FakeCompose(self.root)
        self.ops = self.mod.Operations(self.root, self.compose)

    def rewrite(self, archive, mutate):
        """Rewrite genuine backups with adversarial tar members, then resign."""
        with tarfile.open(archive, "r:gz") as source:
            members = [(item, source.extractfile(item).read() if item.isfile() else None)
                       for item in source]
        members = mutate(members)
        with tarfile.open(archive, "w:gz") as target:
            for item, payload in members:
                target.addfile(item, io.BytesIO(payload) if payload is not None else None)
        self.sign(archive)

    def sign(self, archive):
        Path(str(archive) + ".sha256").write_text(
            hashlib.sha256(archive.read_bytes()).hexdigest() + "  " + archive.name + "\n")

    def test_backup_stops_before_snapshot_and_preserves_keys_wal_and_identity(self):
        archive = self.ops.backup()
        self.assertEqual(archive.parent, self.root / "backups")
        self.assertTrue(self.compose.running)
        self.assertEqual(self.compose.events, ["stop", "start"])
        with tarfile.open(archive) as saved:
            self.assertEqual(saved.extractfile("data/headscale/db.sqlite-wal").read(), b"flushed-on-stop")
            self.assertEqual(saved.extractfile("config/headplane/headscale-api.key").read(), b"server-secret")
            self.assertEqual(saved.extractfile("data/headscale/noise_private.key").read(), b"noise-private-key")
            manifest = json.load(saved.extractfile("manifest.json"))
            self.assertEqual(manifest["platform_version"], "1.0.0")
            self.assertEqual(manifest["sources"]["headscale"]["commit"], "a" * 40)
            self.assertEqual(manifest["image"], "560-headscale-platform:1.0.0")
        self.assertEqual(Path(str(archive) + ".sha256").read_text().split()[0], hashlib.sha256(archive.read_bytes()).hexdigest())
        if os.name != "nt":
            self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
            self.assertEqual(archive.parent.stat().st_mode & 0o777, 0o700)

    def test_backup_preserves_originally_stopped_state(self):
        self.compose.running = False
        archive = self.ops.backup()
        self.assertEqual(self.compose.events, [])
        self.assertFalse(self.compose.running)
        with tarfile.open(archive) as saved:
            self.assertEqual(saved.extractfile("data/headscale/db.sqlite-wal").read(), b"before-stop")

    def test_backup_failure_restarts_originally_running_service(self):
        (self.root / "config/headscale/config.yaml").unlink()
        with self.assertRaises(self.mod.OperationError):
            self.ops.backup()
        self.assertTrue(self.compose.running)
        self.assertEqual(self.compose.events, ["stop", "start"])
        self.assertEqual(list((self.root / "backups").glob("*.tar.gz")), [])

    def test_stop_failure_still_attempts_to_restore_running_state(self):
        self.compose.fail_stop = True
        with self.assertRaisesRegex(Exception, "stop failed"):
            self.ops.backup()
        self.assertTrue(self.compose.running)
        self.assertEqual(self.compose.events, ["stop", "start"])

    def test_backup_rejects_symlink_without_copying_target(self):
        outside = Path(self.temp.name) / "outside-secret"
        outside.write_bytes(b"outside")
        link = self.root / "data/headscale/link"
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest("symlink privilege unavailable")
        with self.assertRaises(self.mod.OperationError):
            self.ops.backup()
        self.assertTrue(self.compose.running)

    def test_restore_requires_explicit_confirmation_before_docker_calls(self):
        archive = self.ops.backup()
        self.compose.events.clear()
        with self.assertRaises(self.mod.OperationError):
            self.ops.restore(archive)
        self.assertEqual(self.compose.events, [])

    def test_restore_replaces_only_known_dirs_preserves_current_sources_and_saves_snapshot(self):
        archive = self.ops.backup()
        (self.root / "data/headscale/db.sqlite").write_bytes(b"new-database")
        (self.root / "config/headplane/headscale-api.key").write_bytes(b"new-key")
        (self.root / "unrelated.txt").write_bytes(b"untouched")
        lock_before = (self.root / "sources.lock.json").read_bytes()
        self.compose.events.clear()
        previous = self.ops.restore(archive, confirm_restore=True)
        self.assertEqual((self.root / "data/headscale/db.sqlite").read_bytes(), b"database")
        self.assertEqual((self.root / "config/headplane/headscale-api.key").read_bytes(), b"server-secret")
        self.assertEqual((self.root / "unrelated.txt").read_bytes(), b"untouched")
        self.assertEqual((self.root / "sources.lock.json").read_bytes(), lock_before)
        self.assertEqual(self.compose.events, ["stop", "start"])
        with tarfile.open(previous) as saved:
            self.assertEqual(saved.extractfile("data/headscale/db.sqlite").read(), b"new-database")
        self.assertTrue((self.root / "data/headplane/empty").is_dir())

    def test_restore_preserves_stopped_state(self):
        self.compose.running = False
        archive = self.ops.backup()
        self.ops.restore(archive, confirm_restore=True)
        self.assertFalse(self.compose.running)
        self.assertEqual(self.compose.events, [])

    def test_checksum_failure_happens_before_stopping_or_modifying_service(self):
        archive = self.ops.backup()
        archive.write_bytes(archive.read_bytes() + b"corruption")
        self.compose.events.clear()
        with self.assertRaises(self.mod.OperationError):
            self.ops.restore(archive, confirm_restore=True)
        self.assertEqual(self.compose.events, [])
        self.assertEqual((self.root / "data/headscale/db.sqlite").read_bytes(), b"database")

    def test_every_archive_member_is_validated_before_stop(self):
        for name, kind in [
            ("../escape", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE),
            ("C:/absolute", tarfile.REGTYPE), ("data/headscale/../escape", tarfile.REGTYPE),
            ("data\\headscale\\escape", tarfile.REGTYPE), ("sources.lock.json", tarfile.REGTYPE),
            ("config/other.yaml", tarfile.REGTYPE), ("data/headscale/link", tarfile.SYMTYPE),
            ("data/headscale/hard", tarfile.LNKTYPE), ("data/headscale/fifo", tarfile.FIFOTYPE),
            ("data/headscale/device", tarfile.CHRTYPE), ("data/headscale/device", tarfile.BLKTYPE),
        ]:
            with self.subTest(name=name, kind=kind):
                archive = self.ops.backup()
                evil = tarfile.TarInfo(name)
                evil.type = kind
                evil.linkname = "../../outside"
                self.rewrite(archive, lambda members: members + [(evil, b"" if kind == tarfile.REGTYPE else None)])
                self.compose.events.clear()
                with self.assertRaises(self.mod.OperationError):
                    self.ops.restore(archive, confirm_restore=True)
                self.assertEqual(self.compose.events, [])

    def test_duplicate_member_is_rejected_before_stop(self):
        archive = self.ops.backup()
        self.rewrite(archive, lambda members: members + [next(m for m in members if m[0].name == "config/headscale/config.yaml")])
        self.compose.events.clear()
        with self.assertRaises(self.mod.OperationError):
            self.ops.restore(archive, confirm_restore=True)
        self.assertEqual(self.compose.events, [])

    def test_archive_size_limits_are_enforced_before_stop(self):
        archive = self.ops.backup()
        self.compose.events.clear()
        with patch.object(self.mod, "MAX_FILE_SIZE", 5):
            with self.assertRaises(self.mod.OperationError):
                self.ops.restore(archive, confirm_restore=True)
        self.assertEqual(self.compose.events, [])

    def test_archive_member_count_and_total_size_limits_are_enforced_before_stop(self):
        for limit, value in [("MAX_MEMBERS", 3), ("MAX_TOTAL_SIZE", 20)]:
            with self.subTest(limit=limit):
                archive = self.ops.backup()
                self.compose.events.clear()
                with patch.object(self.mod, limit, value):
                    with self.assertRaises(self.mod.OperationError):
                        self.ops.restore(archive, confirm_restore=True)
                self.assertEqual(self.compose.events, [])

    def test_oversized_pax_metadata_is_rejected_before_stop(self):
        archive = self.ops.backup()
        evil = tarfile.TarInfo("data/headscale/extra")
        evil.pax_headers = {"comment": "x" * 70000}
        self.rewrite(archive, lambda members: members + [(evil, b"")])
        self.compose.events.clear()
        with self.assertRaises(self.mod.OperationError):
            self.ops.restore(archive, confirm_restore=True)
        self.assertEqual(self.compose.events, [])

    def test_missing_required_config_in_archive_is_rejected_before_stop(self):
        archive = self.ops.backup()
        self.rewrite(archive, lambda members: [pair for pair in members if pair[0].name != "config/headscale/config.yaml"])
        self.compose.events.clear()
        with self.assertRaises(self.mod.OperationError):
            self.ops.restore(archive, confirm_restore=True)
        self.assertEqual(self.compose.events, [])

    def test_corrupt_gzip_with_valid_sidecar_is_rejected_before_stop(self):
        archive = self.ops.backup()
        archive.write_bytes(b"not-a-gzip-tar")
        self.sign(archive)
        self.compose.events.clear()
        with self.assertRaises(self.mod.OperationError):
            self.ops.restore(archive, confirm_restore=True)
        self.assertEqual(self.compose.events, [])

    def test_backup_rejects_hardlinks_and_restores_running_state(self):
        os.link(self.root / "data/headscale/db.sqlite", self.root / "data/headscale/linked-db")
        with self.assertRaises(self.mod.OperationError):
            self.ops.backup()
        self.assertEqual(self.compose.events, ["stop", "start"])

    def test_operation_lock_prevents_overlapping_backup(self):
        (self.root / "backups/.operations.lock").mkdir(parents=True)
        with self.assertRaises(self.mod.OperationError):
            self.ops.backup()
        self.assertEqual(self.compose.events, [])

    def test_mismatched_release_source_or_image_is_rejected_before_stop(self):
        for field, value in [("platform_version", "0.1.0"), ("image", "old:image"), ("sources", {})]:
            with self.subTest(field=field):
                archive = self.ops.backup()
                def mutate(members):
                    result = []
                    for item, payload in members:
                        if item.name == "manifest.json":
                            data = json.loads(payload)
                            data[field] = value
                            payload = json.dumps(data).encode()
                            item.size = len(payload)
                        result.append((item, payload))
                    return result
                self.rewrite(archive, mutate)
                self.compose.events.clear()
                with self.assertRaises(self.mod.OperationError):
                    self.ops.restore(archive, confirm_restore=True)
                self.assertEqual(self.compose.events, [])

    def test_partial_restore_failure_rolls_back_all_four_directories_and_restarts(self):
        archive = self.ops.backup()
        (self.root / "data/headscale/db.sqlite").write_bytes(b"current-db")
        (self.root / "config/headscale/config.yaml").write_bytes(b"current-config")
        original_replace = os.replace
        failed = False
        def fail_one_replacement(source, destination):
            nonlocal failed
            if not failed and Path(destination) == self.root / "data/headscale" and "incoming" in Path(source).parts:
                failed = True
                raise OSError("injected storage failure")
            return original_replace(source, destination)
        self.compose.events.clear()
        with patch.object(self.mod.os, "replace", fail_one_replacement):
            with self.assertRaisesRegex(Exception, "injected storage failure"):
                self.ops.restore(archive, confirm_restore=True)
        self.assertTrue(failed)
        self.assertEqual((self.root / "data/headscale/db.sqlite").read_bytes(), b"current-db")
        self.assertEqual((self.root / "config/headscale/config.yaml").read_bytes(), b"current-config")
        self.assertEqual(self.compose.events, ["stop", "start"])
        self.assertTrue(list((self.root / "backups").glob("pre-restore-*.tar.gz")))

    def test_failed_rollback_retains_recovery_material_and_leaves_service_stopped(self):
        archive = self.ops.backup()
        original_replace = os.replace
        def fail_restore_and_rollback(source, destination):
            if Path(destination) == self.root / "data/headscale" and "incoming" in Path(source).parts:
                raise OSError("restore disk failure")
            if "rollback" in Path(source).parts and Path(destination) == self.root / "config/headscale":
                raise OSError("rollback disk failure")
            return original_replace(source, destination)
        self.compose.events.clear()
        with patch.object(self.mod.os, "replace", fail_restore_and_rollback):
            with self.assertRaisesRegex(self.mod.OperationError, "Rollback incomplete"):
                self.ops.restore(archive, confirm_restore=True)
        self.assertFalse(self.compose.running)
        self.assertEqual(self.compose.events, ["stop"])
        self.assertEqual(len(list((self.root / "backups").glob(".restore-*"))), 1)

    def test_new_host_image_id_is_checked_even_without_existing_container(self):
        controller = self.mod.ComposeController(self.root)
        replies = {
            (*controller.base, "config", "--format", "json"):
                json.dumps({"services": {"platform": {"image": "release:image"}}}),
            (*controller.base, "ps", "--all", "--quiet", "platform"): "",
            ("docker", "image", "inspect", "release:image", "--format", "{{.Id}}"): "sha256:available\n",
        }
        def docker_process(argv, **kwargs):
            self.assertEqual(kwargs["cwd"], self.root)
            self.assertTrue(kwargs["check"])
            self.assertNotIn("shell", kwargs)
            if tuple(argv) not in replies:
                raise AssertionError(f"Unexpected Docker argv: {argv}")
            return SimpleNamespace(stdout=replies[tuple(argv)])
        with patch.object(self.mod.subprocess, "run", docker_process):
            self.assertEqual(controller.metadata(), {"image": "release:image", "image_id": "sha256:available"})

    def test_same_image_from_another_checkout_is_rejected_before_operations(self):
        controller = self.mod.ComposeController(self.root)
        destinations = ("/etc/headscale", "/etc/headplane", "/var/lib/headscale", "/var/lib/headplane")
        container = {"Config": {"Image": "release:image", "Labels": {
            "com.docker.compose.project": "hs560",
            "com.docker.compose.service": "platform",
            "com.docker.compose.project.working_dir": str(self.root),
            "com.docker.compose.project.config_files": str(self.root / "docker-compose.yml"),
        }}, "Image": "sha256:available", "Mounts": [
            {"Type": "bind", "Source": str(self.root / name), "Destination": destination, "RW": name.startswith("data/")}
            for name, destination in zip(self.mod.ROOTS, destinations)
        ]}
        def replies(argv):
            if "config" in argv: return json.dumps({"name": "hs560", "services": {"platform": {"image": "release:image"}}})
            return "sha256:available"
        with patch.object(controller, "_container", return_value=container), patch.object(controller, "_run", side_effect=replies):
            self.assertEqual(controller.metadata()["image_id"], "sha256:available")
            container["Mounts"][0]["Source"] = str(self.root.parent / "production/config/headscale")
            with self.assertRaises(self.mod.OperationError):
                controller.metadata()

    def test_foreign_compose_working_directory_is_rejected_even_with_matching_mounts(self):
        controller = self.mod.ComposeController(self.root)
        container = {"Config": {"Image": "release:image", "Labels": {
            "com.docker.compose.project": "hs560", "com.docker.compose.service": "platform",
            "com.docker.compose.project.working_dir": str(self.root.parent / "foreign"),
        }}, "Image": "sha256:available", "Mounts": []}
        with patch.object(controller, "_container", return_value=container), patch.object(controller, "_run",
            side_effect=lambda argv: json.dumps({"name": "hs560", "services": {"platform": {"image": "release:image"}}}) if "config" in argv else "sha256:available"):
            with self.assertRaises(self.mod.OperationError): controller.metadata()


if __name__ == "__main__":
    unittest.main()

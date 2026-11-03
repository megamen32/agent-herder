import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tarfile
import uuid
import shutil
import unittest
from unittest.mock import patch

FLEET=Path(__file__).resolve().parents[1]/"deploy/fleet"
sys.path.insert(0,str(FLEET))
import deployment_config as config
from deployment_fixture import DARWIN_NODE, LINUX_NODE, TOPOLOGY
from remote_release_gate import Authority, ProtocolError
spec=importlib.util.spec_from_file_location("portable_builder",FLEET/"build-release-candidate.py")
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)

class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)/"private.json"
        self.write(TOPOLOGY)
    def write(self,value):
        self.path.write_text(json.dumps(value))
        self.path.chmod(0o600)
    def test_explicit_private_settings_and_no_repository_fallback(self):
        self.assertEqual(config.load_config(str(self.path))["nodes"],TOPOLOGY["nodes"])
        with patch.dict(os.environ,{},clear=True),self.assertRaisesRegex(RuntimeError,"required"):
            config.load_config()
    def test_permission_owner_and_symlink_fail_closed(self):
        self.path.chmod(0o644)
        with self.assertRaises(RuntimeError):config.load_config(str(self.path))
        self.path.chmod(0o600)
        link=self.path.parent/"link.json";link.symlink_to(self.path)
        with self.assertRaises(RuntimeError):config.load_config(str(link))
        with patch.object(config.os,"getuid",return_value=os.getuid()+1),self.assertRaises(RuntimeError):
            config.load_config(str(self.path))
    def test_config_inside_git_is_rejected(self):
        subprocess.run(["git","init","-q",self.tmp.name],check=True)
        with self.assertRaises(RuntimeError):config.load_config(str(self.path))
    def test_duplicate_keys_unknown_keys_and_duplicate_authority_rejected(self):
        self.path.write_text('{"version":1,"version":1,"nodes":[]}')
        with self.assertRaises(RuntimeError):config.load_config(str(self.path))
        value=copy.deepcopy(TOPOLOGY);value["unexpected"]="private"
        self.write(value)
        with self.assertRaises(RuntimeError):config.load_config(str(self.path))
        value=copy.deepcopy(TOPOLOGY)
        value["nodes"][1]["authorityTarget"]=value["nodes"][0]["authorityTarget"]
        self.write(value)
        with self.assertRaises(RuntimeError):config.load_config(str(self.path))
    def test_explicit_serialized_group_preserves_shared_authority_namespace(self):
        value=copy.deepcopy(TOPOLOGY)
        for node in value["nodes"][:2]:
            node["authorityTarget"]={"fleetDir":"/srv/shared-authority","unit":node["unit"]}
            node["authorityGroup"]="serialized-linux"
        self.write(value)
        selected=config.load_config(str(self.path))["nodes"]
        self.assertEqual(selected[0]["authorityTarget"],selected[1]["authorityTarget"])
        value["nodes"][1]["authorityGroup"]="other-group"
        self.write(value)
        with self.assertRaises(RuntimeError):config.load_config(str(self.path))
        value["nodes"][1]["authorityGroup"]="serialized-linux"
        value["nodes"][1]["authorityTarget"]["fleetDir"]="/srv/different"
        self.write(value)
        with self.assertRaises(RuntimeError):config.load_config(str(self.path))

    def test_authority_symlink_alias_cannot_hide_duplicate_target(self):
        actual=self.path.parent/"authority";actual.mkdir()
        alias=self.path.parent/"alias";alias.symlink_to(actual)
        value=copy.deepcopy(TOPOLOGY)
        value["nodes"][0]["authorityTarget"]["fleetDir"]=str(actual)
        value["nodes"][1]["authorityTarget"]["fleetDir"]=str(alias)
        self.write(value)
        with self.assertRaises(RuntimeError):config.load_config(str(self.path))

    def test_owner_profile_is_explicitly_unsupported_not_silently_ignored(self):
        with self.assertRaises(RuntimeError):
            config.validate_node({**LINUX_NODE,"kind":"owner"})

    def test_git_environment_or_failed_git_probe_cannot_bypass_markers(self):
        subprocess.run(["git","init","-q",self.tmp.name],check=True)
        with patch.dict(os.environ,{"GIT_DIR":"/missing","GIT_WORK_TREE":"/missing"}),patch.object(config.subprocess,"run",side_effect=AssertionError("no git probe allowed")):
            with self.assertRaises(RuntimeError):config.load_config(str(self.path))

    def test_each_descriptor_field_and_authority_mapping_bound_by_digest(self):
        digest=config.descriptor_digest(DARWIN_NODE)
        for key in DARWIN_NODE:
            changed=copy.deepcopy(DARWIN_NODE)
            changed[key]=changed[key]+1 if type(changed[key]) is int else "tampered"
            with self.subTest(key=key),self.assertRaises(RuntimeError):
                config.verify_descriptor(changed,digest)
        changed=copy.deepcopy(DARWIN_NODE)
        changed["authorityTarget"]["fleetDir"]="/srv/other-authority"
        with self.assertRaisesRegex(RuntimeError,"binding"):
            config.verify_descriptor(changed,digest)
    def test_no_arbitrary_command_options_or_path_traversal(self):
        for field,value in (("sshUser","-oProxyCommand=bad"),("address","host;bad"),
                ("unit","service;bad"),("restartCmd","sh -c bad"),("fleetDir","/srv/../other"),
                ("launchdDomain","system"),("pythonBin","relative")):
            changed={**DARWIN_NODE,field:value}
            with self.subTest(field=field),self.assertRaises(RuntimeError):
                config.validate_node(changed)
    def test_one_host_cannot_reuse_another_mapping_or_same_id(self):
        for field in ("id","hostId","address"):
            value=copy.deepcopy(TOPOLOGY)
            value["nodes"][1][field]=value["nodes"][0][field]
            self.write(value)
            with self.assertRaises(RuntimeError):config.load_config(str(self.path))
    def test_selected_descriptor_only_in_private_stage(self):
        canonical=Path("/tmp")/("herder-release."+uuid.uuid4().hex[:8])
        canonical.mkdir(mode=0o700)
        self.addCleanup(shutil.rmtree,canonical)
        path=canonical/"descriptor.json";path.write_text(json.dumps(DARWIN_NODE));path.chmod(0o600)
        self.assertEqual(config.load_remote_descriptor(path,config.descriptor_digest(DARWIN_NODE)),DARWIN_NODE)
        with self.assertRaises(RuntimeError):
            config.load_remote_descriptor(path,"0"*64)
        canonical.chmod(0o755)
        with self.assertRaises(RuntimeError):
            config.load_remote_descriptor(path,config.descriptor_digest(DARWIN_NODE))
        canonical.chmod(0o700)
        with self.assertRaises(RuntimeError):
            config.load_remote_descriptor(self.path,config.descriptor_digest(DARWIN_NODE))
    def test_config_change_during_run_does_not_change_frozen_descriptor(self):
        frozen=config.load_config(str(self.path))["nodes"][2]
        digest=config.descriptor_digest(frozen)
        changed=copy.deepcopy(TOPOLOGY)
        changed["nodes"][2]["authorityTarget"]["fleetDir"]="/srv/new-authority"
        self.write(changed)
        self.assertEqual(config.verify_descriptor(frozen,digest),frozen)
        newer=config.load_config(str(self.path))["nodes"][2]
        with self.assertRaises(RuntimeError):config.verify_descriptor(newer,digest)

    def test_authority_hello_rejects_changed_descriptor_digest_before_check(self):
        from unittest.mock import Mock
        from test_remote_release_gate import contract,hello,request
        c=contract(Path("/tmp/fixture"));gate=Mock();authority=Authority(gate,c)
        args=hello(c);args["descriptorDigest"]="0"*64
        with self.assertRaises(ProtocolError):authority.handle(request(c,1,"hello",args))
        gate.check.assert_not_called()

class PortableManifestTests(unittest.TestCase):
    def test_private_config_is_not_copied_into_release_archive(self):
        sentinel="PRIVATE_LOCAL_CONFIG_SENTINEL"
        spec=importlib.util.spec_from_file_location("portable_archive",FLEET/"rollout-candidate.py")
        rollout=importlib.util.module_from_spec(spec);spec.loader.exec_module(rollout)
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);release=root/"release";(release/"dist").mkdir(parents=True)
            (release/"dist/index.js").write_text("export {};")
            (release/"private-deployment.json").write_text(sentinel)
            (root/"outside-config.json").write_text(sentinel)
            archive=root/"bundle.tar"
            rollout.pack_release(release,archive)
            with tarfile.open(archive) as bundle:
                for member in bundle.getmembers():
                    self.assertNotIn("private-deployment",member.name)
                    if member.isfile():
                        self.assertNotIn(sentinel.encode(),bundle.extractfile(member).read())

    def test_manifest_artifact_has_no_local_settings_paths_or_operational_receipts(self):
        sentinel="PRIVATE_DEPLOYMENT_SENTINEL"
        with tempfile.TemporaryDirectory(prefix=sentinel) as tmp:
            root=Path(tmp);release=root/"release";(release/"dist").mkdir(parents=True)
            (release/"dist/index.js").write_text("export {};")
            (release/"dist/fleet-deployment-manifest.json").write_text(json.dumps({"payload":{"index.js":"0"*64}}))
            (release/"package.json").write_text("{}")
            (release/"package-lock.json").write_text("{}")
            (release/"build-manifest.json").write_text(json.dumps({"bundleFingerprint":sentinel,"builtAt":sentinel,"installNodes":[sentinel]}))
            with (patch.object(builder,"run",side_effect=lambda command:"" if "--porcelain" in command else "1"*40),
                  patch.object(builder,"remote_ref_for",side_effect=AssertionError("private refs must not be read"))):
                result=builder.write_bundle_manifest("1"*40,release,root/"catalog",root/"worktree")
            encoded=(release/"build-manifest.json").read_text()
            self.assertNotIn(sentinel,encoded)
            for field in ("installNodes","excluded","sourceRefs","sourceBranch","catalog","release","worktree"):
                self.assertNotIn('"'+field+'"',encoded)
            self.assertEqual(result["deployment"],{"configuration":"external-private","targetsEmbedded":False})
            self.assertEqual(result["builder"]["script"],"deploy/fleet/build-release-candidate.py")
            self.assertEqual(result["delivery"],3)
            self.assertEqual(result,json.loads(encoded))

if __name__=="__main__":unittest.main()

#!/usr/bin/env python3
"""Inspect or change one semantic rule through the trusted native MCP owner."""
import argparse
import json
import os
from pathlib import Path
from codex_recovery_stand import MCP_META, owner_client, session_tool


def automation(client, **arguments):
    result = client.request("tools/call", {"_meta": MCP_META, "name": "automation",
                                         "arguments": arguments})
    return result["structuredContent"]


def create(client, session_ref, instructions, key):
    return automation(client, action="create", session_ref=session_ref, request_key=key,
                      rule={"kind": "autopilot", "instructions": instructions})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    actions = parser.add_subparsers(dest="action", required=True)
    register = actions.add_parser("register")
    register.add_argument("instance")
    register.add_argument("native_session_id")
    register.add_argument("request_key")
    arm = actions.add_parser("create")
    arm.add_argument("session_ref")
    arm.add_argument("request_key")
    arm.add_argument("instructions")
    listing = actions.add_parser("list")
    listing.add_argument("session_ref")
    for action in ("get", "pause", "update"):
        command = actions.add_parser(action)
        command.add_argument("rule_ref")
        if action != "get":
            command.add_argument("revision", type=int)
        if action == "update":
            command.add_argument("instructions")
    args = parser.parse_args()
    with owner_client(args.owner.resolve(strict=True), args.profile.resolve(strict=True), os.environ) as client:
        if args.action == "register":
            result = session_tool(client, action="register", instance_ref=args.instance,
                                  native_session_id=args.native_session_id, request_key=args.request_key)
        elif args.action == "create":
            result = create(client, args.session_ref, args.instructions, args.request_key)
        elif args.action == "list":
            result = automation(client, action="list", session_ref=args.session_ref)
        else:
            fields = {"rule_ref": args.rule_ref}
            if args.action != "get":
                fields["revision"] = args.revision
            if args.action == "update":
                fields["rule"] = {"kind": "autopilot", "instructions": args.instructions}
            result = automation(client, action=args.action, **fields)
        print(json.dumps(result, ensure_ascii=False))
        return int("code" in result)


if __name__ == "__main__":
    raise SystemExit(main())

"""
Operator CLI (run from backend/):

  python -m app.cli create-user --username admin --full-name "Admin" --role MANAGEMENT
  python -m app.cli reset-password --username ali [--no-force-change]
  python -m app.cli force-password-change-all [--yes]

Passwords are always prompted for (never passed as arguments, so they stay out
of shell history and process listings).
"""
import argparse
import asyncio
import getpass
import sys

from app.db.session import AsyncSessionLocal
from app.services import user_admin
from app.services.auth_service import PasswordPolicyError


def _prompt_password() -> str:
    first = getpass.getpass("Password: ")
    if first != getpass.getpass("Repeat password: "):
        sys.exit("Passwords do not match.")
    return first


async def _run(args: argparse.Namespace) -> int:
    async with AsyncSessionLocal() as db:
        try:
            if args.command == "create-user":
                user = await user_admin.create_user(
                    db, username=args.username, full_name=args.full_name,
                    role_code=args.role, password=_prompt_password(),
                )
                print(f"Created user {user.username!r} (id={user.id}, role={args.role}).")
            elif args.command == "reset-password":
                await user_admin.reset_password(
                    db, username=args.username, password=_prompt_password(),
                    force_change=not args.no_force_change,
                )
                print(f"Password reset for {args.username!r}; all their sessions were ended.")
            elif args.command == "force-password-change-all":
                if not args.yes and input("Force ALL active users to change password and log out everyone? Type YES: ") != "YES":
                    print("Aborted.")
                    return 1
                count = await user_admin.force_password_change_all(db)
                print(f"{count} active users must change their password at next login.")
        except PasswordPolicyError as exc:
            print(f"Password rejected: {', '.join(exc.errors)}", file=sys.stderr)
            return 2
        except ValueError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 2
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("create-user")
    p.add_argument("--username", required=True)
    p.add_argument("--full-name", required=True)
    p.add_argument("--role", default="MANAGEMENT", choices=["USER", "EXPERT", "MANAGEMENT", "AUDITOR"])

    p = sub.add_parser("reset-password")
    p.add_argument("--username", required=True)
    p.add_argument("--no-force-change", action="store_true",
                   help="do not require the user to change this password at next login")

    p = sub.add_parser("force-password-change-all")
    p.add_argument("--yes", action="store_true", help="skip the confirmation prompt")

    sys.exit(asyncio.run(_run(parser.parse_args())))


if __name__ == "__main__":
    main()

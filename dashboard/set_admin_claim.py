#!/usr/bin/env python3
"""
set_admin_claim.py  —  one-time setup.

Grants the `admin: true` custom claim to one or more accounts (your workshop
hosts). Under database.rules.json, only accounts with this claim can read
participant data and write the section gates / broadcast warnings.

Prereqs:
  pip install firebase-admin
  - A service-account key at ./serviceAccountKey.json  (SETUP.md step 5)
  - Each host account already created via Email/Password  (SETUP.md step 4)

Usage:
  python set_admin_claim.py host1@example.com
  python set_admin_claim.py host1@example.com host2@example.com
"""
import sys
import firebase_admin
from firebase_admin import auth, credentials

def grant_admin(email):
    """Set admin claim for a single email. Returns True on success."""
    try:
        user = auth.get_user_by_email(email)
    except auth.UserNotFoundError:
        print(f"  SKIP  {email} — no such user (create it first, SETUP.md step 4)")
        return False
    except Exception as e:
        print(f"  ERROR {email} — {e}")
        return False

    auth.set_custom_user_claims(user.uid, {"admin": True})
    refreshed = auth.get_user(user.uid)        # verify it stuck
    print(f"  OK    {email} (uid={user.uid}) claims now: {refreshed.custom_claims}")
    return True

def main():
    emails = sys.argv[1:]
    if not emails:
        print("Usage: python set_admin_claim.py <admin-email> [<admin-email> ...]")
        sys.exit(1)

    cred = credentials.Certificate("serviceAccountKey.json")
    firebase_admin.initialize_app(cred)

    print(f"Granting admin to {len(emails)} account(s):")
    results = [grant_admin(e) for e in emails]

    ok = sum(results)
    print(f"\nDone — {ok}/{len(emails)} succeeded.")
    print("Each host must sign out / sign in again for the new claim to take effect.")
    if ok < len(emails):
        sys.exit(1)

if __name__ == "__main__":
    main()

# Architecture Decisions

## Owner-approved admin registration

**Date:** 2026-07-05

Once an owner exists, Admin Studio registration creates a pending
`_admin_requests` record rather than a user. The submitted password is hashed
before persistence and is never returned by the dedicated API. Only a caller
whose live database role is `owner` may list, approve, or reject requests.
Approval atomically creates an `admin` user and removes the request.
If the email already belongs to a regular user, the submitted password must
match that account and approval promotes the existing row instead. Existing
admin and owner accounts cannot submit requests.

Ordinary `/api/auth/signup` behavior remains unchanged for application users.
Admin Studio uses the stricter `/api/auth/owner` bootstrap endpoint so a stale
registration screen cannot accidentally create a regular user after another
client has already created the owner.

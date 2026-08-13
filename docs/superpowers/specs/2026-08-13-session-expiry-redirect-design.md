# An expired session returns to the login screen (TRE-63)

## The problem

Leave the app open, sleep the machine, come back after an hour. The tab regains
focus, the explorer refetches, every call comes back 401, and the panes read
`listing failed`. The app never returns to the login screen, and nothing on
screen says the session is the reason.

## What already works

The focus half of this is not missing.

- `refetchOnWindowFocus: true` with a 10s `staleTime` (`front/src/app/providers.tsx`)
  means returning to the tab already fires the refetches. The requests go out.
- The session is a one-hour rolling cookie (`nest-api/src/users/session.constants.ts`),
  so a lunch break is enough to end it. A sleeping laptop sends nothing, so
  nothing pushes the expiry back.
- `apiRequest` already throws an `ApiError` carrying `status`, so the 401 is
  known precisely where it arrives.

## What is missing

Nothing turns *the API said 401* into *go to the login screen*.

- Every query is `throwOnError: false` and renders its own error state, so a
  401 becomes whatever that particular component says about a failed request.
- `ErrorState` in `front/src/components/explorer/pane.tsx` maps anything that is
  not 403/404/502 to `listing failed`, which is true and useless.
- The server-side guard in `front/src/app/(private)/layout.tsx` only runs on a
  full render. A client-side refetch never reaches it.

## Design

### 1. The API client announces the refusal

`front/src/lib/api/client.ts` gains a module-level, single-slot listener,
notified the moment a 401 is known and before the throw.

**Why here.** Three reasons, in order of weight:

1. **Speed.** Queries default to three retries with backoff. A handler on React
   Query's `QueryCache` would not fire until those are exhausted — roughly seven
   seconds of `listing failed` before anything happens. This fires on the first
   refusal.
2. **Coverage.** Not every call is a query. `saveLastLayout` is fire-and-forget
   and would never reach a query-cache handler at all.
3. **Placement.** `client.ts` is already documented as "the one way this app
   talks to the API from the browser". This is that.

A single slot rather than a `Set`: there is exactly one subscriber by
construction, and a `Set` would quietly permit a second one — which means a
second redirect. The unsubscribe compares identity, so React's StrictMode
mount → unmount → mount leaves the listener installed rather than cleared.

### 1b. Not every 401 is a session ending

Some endpoints answer 401 to mean *what you sent is wrong*: sign-in with a bad
password, recovery with a bad passphrase. Those must not trigger a redirect.

Mounting the subscriber only in the private tree already covers those two, since
both are submitted from public pages — but that is an accident of mounting, not
a stated rule, and it does not cover the case that matters. `PATCH
/users/password` is **session-guarded** and answers 401 when the *current*
password is mistyped (`users.service.ts`). There is no change-password form in
the front today, so nothing is broken; the day someone adds one, a typo would
sign the operator out mid-sentence, and nothing at that call site would hint at
why.

So `RequestOptions` gains `credentialCheck`, set on the calls whose 401 is a
verdict on their payload. Declared per call rather than as a path denylist
inside `client.ts`, because it then sits in `api/users.ts` among the endpoints
it describes — which is the file the author of that future form will be editing,
and `client.ts` is not.

### 2. One subscriber, mounted only in the private tree

A new client component, `front/src/auth/session-expiry.tsx`, rendered by
`(private)/layout.tsx`. On notification it clears the auth context and
`router.replace`s to the login screen with a marker parameter.

It is guarded by a ref. A focus refetch 401s on both panes, the sidebar and the
activity strip at roughly the same moment; that is one redirect, not four.
Correctness does not rest on the effect's dependencies being stable — the
subscription is idempotent, so a re-subscribe changes nothing, and the ref
survives re-renders either way.

**Why the private tree and not `Providers`.** A wrong password is also a 401
(`users.service.ts`). Mounted globally, a typo would redirect the user to the
page they are already on and wipe the form they were filling. Mounted under
`(private)`, no subscriber exists on public pages, so a rejected sign-in
announces into nothing.

### 3. The cache is wiped at sign-in, not at expiry

The `QueryClient` lives in the root `Providers` and survives the navigation to
the login screen, so without a wipe a *different* account signing in on this tab
would inherit the previous one's cached listings.

The wipe belongs in `useCredentials`, not in the expiry handler. Clearing the
cache while the explorer is still mounted removes queries out from under live
observers, which immediately refetch — a burst of doomed requests and a flash of
loading state during the redirect. At sign-in no private query is mounted, and
it is the exact moment the wipe protects anything.

### 4. The login screen says why

The redirect carries a marker parameter, which the login page reads and renders
through the `notice` slot `AuthCard` already has.

Silence is the more common convention, but it suits apps whose sessions last
weeks and whose expiry is rare. At one hour this happens whenever the operator
steps away, and a silent bounce to a login form is indistinguishable from a
crash or from having been signed out elsewhere.

A query parameter rather than storage: it survives a reload, it is visible to
anyone debugging, and `useCredentials` already replaces the URL on success, so
it does not linger.

The copy names the recovery as well as the cause, because the layout genuinely
does come back — see below.

### 5. The pane stops lying

`ErrorState` gains a 401 arm. The redirect is asynchronous, so the error state
still renders for the tick before the navigation lands; it should say what is
actually happening. The detail is written rather than taken from the API,
because the guard's own words there are `Session required` — accurate, and not
addressed to a person.

## Deliberately not in scope

- **No return-to-where-you-were parameter.** Sign-in lands on `/`, which cold
  opens and restores the stored layout: both panes' host, path, sort and
  direction, plus split, view, heat, inspector and glob (TRE-51). That already
  is where the operator was, and it is stored server-side per account rather
  than smuggled through a URL.
- **No keep-alive or token refresh.** A sleeping laptop makes no requests, which
  is what the expiry is for. Defeating it would be a security change wearing a
  usability costume.
- **No sign-out control.** `logout()` in `lib/api/users.ts` is still unused;
  giving it a button is its own piece of work.
- **A network failure does not sign anyone out.** An unreachable API throws
  before there is a status to read, so it never reaches the 401 path. A blip on
  the train is not a session ending.
- **No notice on the reload path, and it cannot have one.** Someone who presses
  F5 rather than simply returning to the tab already lands on the login screen —
  the server guard has always handled that, which is why the bug only ever
  showed on the focus-refetch route — but they arrive without the notice.

  It looks like the private layout could pass one along by asking *why* the
  session was missing. It cannot. The cookie is `rolling: true` with
  `maxAge` set to the same one hour as the Redis TTL (`nest-api/src/main.ts`),
  so by the time this matters the browser has deleted the cookie itself and
  sends nothing. `getServerSession` returns null on its no-cookie early return,
  never reaching the 401 branch, and an expired visitor is indistinguishable
  from a first-time one. The same fact is why the browser-side 401 arrives at
  all: the request goes out bare and the guard refuses it.

## Verification

There is no test runner in `front/` yet (TRE-39), and the existing `verify:*`
scripts check pure functions against reality — they have no browser to drive, so
this cannot join them.

- `pnpm typecheck` and `pnpm lint` in `front/`, locally.
- By hand: sign in, drop the session key from Redis on the server, return to the
  tab, and confirm the app lands on the login screen carrying the notice rather
  than showing `listing failed`.
- By hand: submit a wrong password on the login screen and confirm the form is
  left alone — the case that pins the subscriber's placement.

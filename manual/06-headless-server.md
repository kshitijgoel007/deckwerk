# Running a headless collaboration server

A headless DeckWerk server keeps a collection of presentations available for
collaborative editing without running the desktop editor. This is useful for a
lab workstation, a small team server, or a machine on a tailnet.

## Trust and access

Only run the server on a network you trust. The headless server does not provide
public-service security: there are no user accounts, access-control lists, or
TLS termination. Anyone who can reach it can open and edit the presentations it
exposes.

Do not expose it directly to the public internet. A private local network or a
tailnet is the intended environment.

## Prepare the presentations

Choose one folder to be the server's presentation library. Each immediate
subfolder containing a DeckWerk presentation appears in the browser.

For example:

```text
shared-decks/
  weekly-meeting/
  project-demo/
  lecture-series/
```

The server cannot read or write outside this library. People using the browser
can open its presentations, create new ones, and import presentations into it.

Do not open the same presentation in the desktop editor while the headless
server is running. During a headless session, the server must be the only
process writing that presentation folder.

## Start the server

The commands below assume a DeckWerk source checkout with its dependencies
installed.

Build the browser client once:

```bash
npm run build:collab
```

Then start DeckWerk with the path to the presentation library:

```bash
npm run collab -- /path/to/shared-decks
```

DeckWerk prints the addresses people can open. By default it listens on port
`5800` and makes itself reachable through the machine's network interfaces,
including a configured tailnet interface.

Send one of those addresses to collaborators on the same trusted network. They
open it in a browser, choose a presentation, enter their name, and begin
editing. There is nothing to install on their machines.

To choose another port:

```bash
npm run collab -- /path/to/shared-decks --port 5900
```

To make the service available only on the server machine:

```bash
npm run collab -- /path/to/shared-decks --host 127.0.0.1
```

## What happens during a session

The server holds the authoritative version of each open presentation. It orders
incoming edits, broadcasts them to everyone, and saves changes back into the
presentation folder. Participants see one another's current slide, cursor,
selection, and edits in real time.

Anyone in the session can present or download the current presentation. Images
and videos remain ordinary files inside the presentation folder.

If a presentation or its theme is changed by another trusted tool on the server,
the session notices the change and updates connected browsers.

## Stop the server

Press **Ctrl+C** in the terminal where the server is running. DeckWerk finishes
saving open presentations before it exits.

Stopping the process disconnects collaborators, but it does not delete their
work or remove any presentations.

## Optional shared agent

The headless server has an experimental shared-agent mode:

```bash
npm run collab -- /path/to/shared-decks --shared-agent
```

This gives every collaborator access to one server-owned Codex account and
conversation. It is intended for controlled demos and trusted teams, not as a
multi-user account system. Sign-in and account switching are available only
from `http://127.0.0.1:5800` on the server machine. Replace `5800` if you chose
a different port.

Without `--shared-agent`, the collaborative editor works normally and no shared
agent account is exposed.

## Laptop-hosted sessions

For an ad hoc session around one open presentation, use **Collaborate** in the
desktop app instead. DeckWerk hosts only that presentation, copies its invite
link, and takes care of handing control between the desktop editor and the live
session. Choose **End collaboration** when everyone is finished.

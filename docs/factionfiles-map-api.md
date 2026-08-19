# What the ADS Config Builder needs from FactionFiles

For whoever is working on the FactionFiles site. This is a statement of needs,
not a design. You know the site, its data, and what it already serves; we do
not, so nothing here is a prescription about endpoints or shapes. Where we have
been specific it is about our own constraints, which you have no way of knowing
from your side.

## What we are building

The ADS Config Builder is a web tool that writes `ads.toml`, the config file for
an Alpine Faction dedicated server. Part of that file is the map rotation, a
list of `.rfl` file names:

```toml
[[levels]]
filename = "ctf_deathinstinct.rfl"
```

Today you type those names by hand, with no confirmation the name is spelled
right and no way to browse. We want a map picker: search, look at the map, click
it, and the correct file name lands in the rotation.

## The constraint everything else follows from

**The tool is a static page with no backend of ours.** The browser talks to you
directly, from our origin to yours. Three consequences, all of them ours rather
than yours, and all of them things we cannot engineer around:

- Responses have to be readable cross-origin. Without that the browser sends the
  request and then refuses to let us read what came back, so the feature does
  not exist. This is the one hard requirement in this document.
- We cannot set a `User-Agent`. Browsers do not allow it at any value. If an
  endpoint distinguishes the game client by its agent string, we cannot pass as
  one.
- We cannot hold a secret. Anything the page carries is readable by anyone who
  opens it, so a key would not be gating anything.

**We cannot give you our final origin yet.** The tool is not deployed and the
host gets picked in our last milestone. If you need an exact origin rather than
a wildcard, we will send it the day it is decided. Our dev origin in the
meantime is `http://localhost:5173`, give or take a few ports. We have no need
for `file://` to work.

## What we need

1. **Read access from the browser**, per the constraint above.
2. **Search that matches either name a map has.** People know a map by its
   display title or by its `.rfl` file name, and which one they reach for
   depends on the person and the map. They are typing into one box and we have
   no way to tell which they meant, so a single query needs to match against
   both. Substring matching on each covers what people actually type.
3. **The exact `.rfl` file name on every result.** This is the one field we
   cannot do without: it is literally what we write into the config. A result we
   cannot turn into an exact file name is not usable by this tool, however good
   the rest of it is, so an upload with no level name mapped to it is one we
   would rather never see in the results.
4. **A way to ask about a whole list of file names at once**, and be told which
   of them the autodownloader has. This is not for the picker. The tool has a
   diagnostics pass that checks a finished config for the things that will go
   wrong once it is live, and "this map is not on the autodownloader" belongs in
   it: every player who joins on that map fails to download it. We want to raise
   that while the config is still being written rather than after it ships. A
   rotation is routinely twenty to fifty maps, so asking one name at a time is
   not really how we would like to ask. If something along these lines already
   exists, pointing us at it is a complete answer.

That is the whole floor. Everything below is want, not need.

## What we would like

**Enough to show a map to someone who is deciding.** Display title, author,
description, file size, upload date, and a thumbnail. A download or detail link
so we can send people to you rather than reimplementing your pages.

**The mode a map was intended for, as your site already categorizes it.** We do
not need this derived or verified, and we would not use it to call a rotation
wrong: maps are reusable, and a Deathmatch map running Gun Game is an ordinary
thing to do. It is there for the person to eyeball. Your category next to the
mode they scheduled, and they can tell at a glance whether that pairing was what
they meant.

The same field would let someone narrow a search to the mode they are building
for, which is the other half of its value.

Alpine's fourteen game types, as the config file spells them, in case it helps
to see what we would be lining your categories up against:

```
dm     Deathmatch
ctf    Capture the Flag
tdm    Team Deathmatch          also accepted: teamdm
koth   King of the Hill
dc     Damage Control
rev    Revolt
run    Run
esc    Escalation
bag    Bagman                   also accepted: bm, bagman
tbag   Team Bagman              also accepted: tbm
pit    Pit
wo     Wipeout                  also accepted: wipeout
gg     Gun Game                 also accepted: gungame
sal    Salvage                  also accepted: salvage
```

Send whatever shape your data is in, a category ID or a display string alike,
and we will map it here. Do not reshape anything for us, and do not worry about
the cases where your categories and this list do not line up one to one; a
category we cannot map is one we show as you wrote it.

**A way to keep a broad search bounded.** A two letter query should not return
the archive. However you want to page it is fine. Knowing the total, or just
that there are more, lets us say "137 maps, showing 25".

## Things that would leave us stuck

Browser rules rather than preferences, listed so none of them is a surprise
late:

- **A required custom request header**, including an API key header. It makes
  every request a preflighted one, and a key in a static page is public anyway.
  If you want an identifier for logging, something we can put in the URL is
  fine.
- **A required `User-Agent`**, per above. There is no workaround on our side.
- **Error pages that return a 200**. We need the status to be real and the body
  to stay machine readable on failure, or every error reaches a server operator
  as a parse error we cannot explain to them.
- **Redirects to a different origin**, unless the final response is readable
  cross-origin too. The browser checks the end of the chain.
- **Thumbnails gated on `Referer`.** Images themselves need nothing special from
  you, but hotlink protection would break them in the page. Tell us if it is on
  and we will work around it or drop thumbnails.

## What we do on our end

- Typing is debounced, so a search goes out after a pause rather than per
  keystroke, and results are cached in the page for the session.
- Batched requests where you offer them, sized however you tell us.
- Tell us any rate limit and we will code to it. `Cache-Control` on your
  responses is welcome and we will honor it.
- **No scraped snapshot of the archive.** Live queries only, always against you.
- **The picker is additive.** Typing an `.rfl` name by hand stays a first-class
  path, and if the API is unavailable the tool works exactly as it does now.
- Happy to credit and link FactionFiles from the picker, worded however you
  like.

## Questions back

1. Is there anything on this list you already serve, that we should simply be
   calling?
2. Wildcard or a named origin? If named, we will send ours when the host is
   picked.
3. Is the site category per map something you can hand us with a search result?
4. Any rate limit we should code against?

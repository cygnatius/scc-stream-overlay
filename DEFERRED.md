# Deferred work — documented for later delivery

Items agreed out of scope for the current pass, with enough specification
pointers that a later pass can build against them without re-deriving intent.

---

## 1. Posting the game PGN to Pairingsman at game end

**What:** when a streamed game finishes, POST the final PGN to

```
POST {base}/api/v1/broadcast/pairings/{id}/game
Authorization: Bearer <token>
```

**Why deferred:** two prerequisites do not exist yet on the Pairingsman side:

- a **write ability on the broadcast token** — current tokens are read-only,
  and the overlay must never hold a broader credential than it needs;
- a **`pairing_games` table** to receive the submission.

**Authoritative spec:** `BROADCAST-SCORING.md` in the Pairingsman project is
the agreed specification for this endpoint — request fields, validation,
result semantics and idempotency live there. **Do not build from this file
alone; read that one first.** The sketch below is illustrative only, kept
minimal on purpose so the two repos cannot drift:

```jsonc
// POST body — see BROADCAST-SCORING.md for the authoritative shape
{
  "pgn": "...",              // full movetext with clock annotations where known
  "result": "1-0",           // optional override; omitted → derive from PGN
  "forfeit": false           // see §3
}
```

Client-side behaviour when built: fire once per game on a confirmed game-end
(the same confidence-gated detector that drives the game-end scene sequence),
queue and retry on network failure, and surface success/failure in admin only
— never on stream.

## 2. Deriving the result from the PGN

The submission derives the result from the PGN termination when present
(checkmate / stalemate / flag detected from the feed), with an explicit
`result` override field in the request for operator corrections (set from the
admin postgame result control). Display formatting stays exactly as the
Pairingsman payload returns it — the overlay performs no score translation
anywhere, in either direction.

## 3. Forfeit flagging

A forfeit is a result with no PGN to speak of. The request carries a
`forfeit` flag so Pairingsman can record a default win/loss without move
data. Admin needs a small "declare forfeit" control on the postgame card
(which also sets the on-stream result text, e.g. "White wins on forfeit").

## 4. LAN scan fallback for locating LiveChess

The venue is single-machine (LiveChess on 127.0.0.1) with a manual host
override for the two-machine fallback. A convenience "scan the local subnet
for port 1982" button in Admin → Board could locate a LiveChess PC without
the ipconfig ritual. Deliberately deferred: it is pure convenience, touches
the network stack (subnet enumeration from a browser context needs the local
server to do the probing), and the manual override already covers the need.

## 5. Migration path: serving the overlay from Pairingsman

Long-term option: Pairingsman serves display/admin itself (Laravel routes +
the same static assets), replacing `server.js`, so one deployment carries
both systems. Prerequisites and open questions to resolve at that point:

- config storage moves from `config/*.json` to Pairingsman (per-association
  settings), keeping the same defaults-over-merge semantics and the same
  `/api/config` + hash-poll contract so the display code ports unchanged;
- the LiveChess websocket is a **local** connection — a cloud-served page
  cannot reach `ws://127.0.0.1:1982` from a secure origin, so either a local
  companion process stays (thin LiveChess bridge) or the overlay keeps a
  local server at the venue regardless — this is the crux to design first;
- asset upload moves to Pairingsman storage with the same kind whitelist.

---

*Context for all of the above: the Pairingsman broadcast read API contract is
`docs/operations/broadcast-api.md` in the Pairingsman repo (being produced as
a deliverable there). This repo references it rather than duplicating payload
shapes, so the contract cannot drift between the two projects.*

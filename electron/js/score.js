// ── Feed ranking algorithm ─────────────────────────────────────────────────────
/**
 * score.js — Client-side post ranking.  Runs entirely in the browser; no server
 * involvement.  The same post may have a different score for each viewer.
 *
 * Final score:  P = B + R − T
 *
 *   S  Social status with the poster (10 / 20 / 30)
 *   H  Like score — the daemon's "posts" response includes the full likes array
 *      (each entry has liker_pubkey), so relationship weighting is applied:
 *      unknown +1 / one-way follow +2 / mutual +3.
 *   C  Comment score — commenter pubkeys ARE available, so relationship weighting
 *      is applied: unknown +2 / one-way follow +4 / mutual +6.
 *   D  Decay — hours elapsed since the post was created.
 *   L  Seeded luck — deterministic random per (post_id, viewer, hour bucket).
 *   B  Bond: max( log2(2+H+C+S), 1 )
 *   T  Time penalty: min( e^(0.02·D) / (log2(2+C) + S/10), B )
 *   R  Residual luck: max( L−D, 1 )
 */

// ── Internal helpers ──────────────────────────────────────────────────────────

// Deterministic float in [0, 1) from a string seed.
// Uses djb2 hashing followed by two rounds of integer finalisation (avalanche).
function _seededRand(seedStr) {
  let h = 5381;
  for (let i = 0; i < seedStr.length; i++) {
    h = (Math.imul(h, 31) + seedStr.charCodeAt(i)) | 0;
  }
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0xFFFFFFFF;
}

// Follow relationship of the viewer with posterPubkey:
//   0 = viewer does not follow poster
//   1 = viewer follows, but poster does not follow back
//   2 = mutual follow
function _posterRel(posterPubkey) {
  const iFollow   = isFollowing(posterPubkey);
  const theyFollow = knownFollowers.has(posterPubkey);
  if (iFollow && theyFollow) return 2;
  if (iFollow) return 1;
  return 0;
}

// S — social status with the poster.
// Own posts are treated as mutual-follow equivalent (S = 30).
function _scoreS(posterPubkey) {
  if (posterPubkey === myIdentity?.pubkey) return 30;
  const rel = _posterRel(posterPubkey);
  if (rel === 2) return 30; // mutual follow
  if (rel === 1) return 20; // viewer follows, not reciprocated
  return 10;                // viewer does not follow
}

// H — like score (relationship-weighted).
// post.likes is an array of { liker_pubkey, … } objects from the daemon's
// "posts" response.  Falls back to like_count × 1 only in demo mode where
// the likes array is absent.
function _scoreH(post) {
  const likers = Array.isArray(post.likes) ? post.likes : null;
  if (!likers) return Math.max(0, Number(post.like_count) || 0); // demo fallback
  let score = 0;
  for (const lk of likers) {
    const pk = lk.liker_pubkey;
    if (!pk || pk === myIdentity?.pubkey) continue; // skip own likes
    const iFollow    = isFollowing(pk);
    const theyFollow = knownFollowers.has(pk);
    if (iFollow && theyFollow) score += 3; // mutual follow
    else if (iFollow)          score += 2; // viewer follows, not reciprocated
    else                       score += 1; // unknown / not followed
  }
  return score;
}

// C — comment score (relationship-weighted because commenter pubkeys are known).
function _scoreC(postId) {
  const comments = commentsByPost[postId];
  if (!Array.isArray(comments) || comments.length === 0) return 0;
  let score = 0;
  for (const c of comments) {
    const pk = c.sender_pubkey;
    if (!pk || pk === myIdentity?.pubkey) continue; // skip own comments
    const iFollow    = isFollowing(pk);
    const theyFollow = knownFollowers.has(pk);
    if (iFollow && theyFollow) score += 6; // mutual follow
    else if (iFollow)          score += 4; // viewer follows, not reciprocated
    else                       score += 2; // unknown / not followed
  }
  return score;
}

// D — hours elapsed since the post timestamp.
function _scoreD(post) {
  const ts = new Date(post.timestamp).getTime();
  if (!ts || isNaN(ts)) return 0;
  return Math.max(0, (Date.now() - ts) / 3_600_000);
}

// L — seeded luck factor.
// X is larger for unfamiliar posters so strangers can occasionally surface high.
// The seed includes floor(D) so the value is stable within an hour but shifts
// each hour, introducing gentle churn without full re-randomisation.
function _scoreL(post, D) {
  const rel = _posterRel(post.sender_pubkey);
  const X   = rel === 2 ? 3 : rel === 1 ? 11 : 21;
  const seed = `${post.post_id}|${myIdentity?.pubkey || ''}|${Math.floor(D)}`;
  return 1 + _seededRand(seed) * (X - 1); // float in [1, X]
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * scorePost(post) — compute score P for a single post object.
 *
 * Returns a finite float.  Use Math.round() for display only; store and sort
 * on the raw float to preserve ranking fidelity.
 */
function scorePost(post) {
  if (!post || typeof post !== 'object') return 0;

  const D = _scoreD(post);
  const S = _scoreS(post.sender_pubkey);
  const H = _scoreH(post);
  const C = _scoreC(post.post_id);
  const L = _scoreL(post, D);

  const B = Math.max(Math.log2(2 + H + C + S), 1);
  const T = Math.min(Math.exp(0.02 * D) / (Math.log2(2 + C) + (S / 10)), B);
  const R = Math.max(L - D, 1);

  return B + R - T;
}

// ── Score info popup ──────────────────────────────────────────────────────────

const SCORE_EXPLANATION = `This score is calculated just for you. It combines your relationship to the person who posted, how people interacted with the post, a bit of randomness, and how old the post is.

Posts from people you're closer to (follows and mutual follows) start with a higher base. Likes and comments increase the score, and interactions from people you follow count more than those from people you don't. Comments generally boost a post more than likes.

A small amount of randomness helps surface different posts, so the feed isn't always the same. Over time, all posts lose points and eventually disappear, even if they're popular.

Everything is computed locally on your device, so your feed may look different from someone else's.`;

/**
 * showScoreInfo(event) — toggle the ranking explanation popover.
 * Clicking the 🧮 button a second time, or clicking anywhere else, closes it.
 */
function showScoreInfo(event) {
  event.stopPropagation();

  // Toggle: clicking the button again closes the popup
  const existing = document.getElementById('score-info-popup');
  if (existing) { existing.remove(); return; }

  const popup = document.createElement('div');
  popup.id = 'score-info-popup';
  popup.className = 'score-info-popup';
  popup.textContent = SCORE_EXPLANATION;
  document.body.appendChild(popup);

  // Always centre on screen regardless of which post was clicked
  popup.style.top       = '50%';
  popup.style.left      = '50%';
  popup.style.transform = 'translate(-50%, -50%)';

  // Close on next click anywhere outside the popup
  setTimeout(() => {
    document.addEventListener('click', function _close(e) {
      if (!popup.contains(e.target)) {
        popup.remove();
        document.removeEventListener('click', _close);
      }
    });
  }, 0);
}

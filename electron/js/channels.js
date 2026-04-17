// ── Channels ───────────────────────────────────────────────────────────────────
/**
 * Channels are implemented as a simple content-addressing scheme layered on top
 * of the existing broadcast mechanism.  A channel post is a normal broadcast
 * whose content begins with CHANNEL_MAGIC followed by the channel name, a
 * newline, then the actual post text.
 *
 * Wire format:  "agora:channel:v1:<name>\n<text>"
 *
 * Channel names are validated to letters, numbers, underscores, and dashes up
 * to 32 characters.  The daemon treats these as opaque content — all channel
 * routing and filtering is purely client-side.
 *
 * Channel blocking uses the same owned-list mechanism as peer blocking.
 * A blocked channel's posts are excluded from renderFeed() and the channel
 * strip does not show it.
 */
const CHANNEL_MAGIC = 'agora:channel:v1:';
const CHANNEL_NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

// Encode a post for a specific channel by prepending the magic prefix.
function encodeChannelPost(channelName, text) {
  return CHANNEL_MAGIC + channelName + '\n' + text;
}

// Parse a post body — returns { channel, text } if it's a channel post, null otherwise.
function parseChannelPost(content) {
  if (typeof content !== 'string' || !content.startsWith(CHANNEL_MAGIC)) return null;
  const rest = content.slice(CHANNEL_MAGIC.length);
  const nl = rest.indexOf('\n');
  if (nl < 0) return null;
  const channel = rest.slice(0, nl);
  if (!CHANNEL_NAME_RE.test(channel)) return null;
  return { channel, text: rest.slice(nl + 1) };
}

function loadBlockedChannels() {
  try {
    const saved = localStorage.getItem('agora_blocked_channels');
    if (saved) blockedChannels = new Set(JSON.parse(saved));
  } catch {}
}

function saveBlockedChannels() {
  try { localStorage.setItem('agora_blocked_channels', JSON.stringify([...blockedChannels])); } catch {}
}

function isChannelBlocked(name) { return blockedChannels.has(name) || isChannelBlockedByList(name); }

function blockChannel(name) {
  blockedChannels.add(name);
  saveBlockedChannels();
  if (activeChannel === name) setActiveChannel(null);
  else renderFeed();
  renderBlockedModal();
  toast(`Channel #${name} blocked`, 'success');
}

function unblockChannel(name) {
  blockedChannels.delete(name);
  saveBlockedChannels();
  renderFeedChannelStrip();
  renderBlockedModal();
  toast(`Channel #${name} unblocked`, 'info');
}

function toggleBlockActiveChannel() {
  closeChannelMenu();
  if (!activeChannel) return;
  if (isChannelBlocked(activeChannel)) unblockChannel(activeChannel);
  else blockChannel(activeChannel);
  updateChannelMenuBtn();
}

function updateChannelMenuBtn() {
  const menuBtn   = document.getElementById('ch-menu-btn');
  const followItem = document.getElementById('ch-follow-item');
  const blockItem  = document.getElementById('ch-block-item');
  if (!menuBtn) return;
  const blocked   = activeChannel && isChannelBlocked(activeChannel);
  const following = activeChannel && isFollowingChannel(activeChannel);
  if (followItem) {
    followItem.textContent = following ? '✓ Following Channel' : 'Follow Channel';
    followItem.classList.toggle('is-active', !!following);
  }
  if (blockItem) {
    blockItem.textContent = blocked ? 'Unblock Channel' : 'Block Channel';
  }
}

// keep old name as alias so nothing else breaks
function updateChannelBlockBtn() { updateChannelMenuBtn(); }

function toggleChannelMenu(e) {
  e.stopPropagation();
  const dd = document.getElementById('ch-dropdown');
  if (!dd) return;
  updateChannelMenuBtn();
  dd.classList.toggle('open');
}

function closeChannelMenu() {
  const dd = document.getElementById('ch-dropdown');
  if (dd) dd.classList.remove('open');
}

// Derive the list of channels visible in the channel strip by scanning post
// content for the channel magic prefix.  Blocked channels are excluded so they
// don't appear in the UI at all.
function discoverChannels() {
  const seen = new Set();
  for (const p of posts) {
    const ch = parseChannelPost(p.content);
    if (ch && !isChannelBlocked(ch.channel)) seen.add(ch.channel);
  }
  return [...seen].sort();
}

function setActiveChannel(name) {
  activeChannel = name || null;
  closeChannelMenu();
  const title   = document.getElementById('feed-title');
  const hint    = document.getElementById('feed-hint');
  const menuBtn = document.getElementById('ch-menu-btn');
  if (title)   title.textContent = name ? `# ${name}` : '📢 Public Feed';
  if (hint)    hint.textContent  = name ? `Channel · posts propagate for 24h` : 'Posts propagate for 24h';
  if (menuBtn) menuBtn.style.display = name ? '' : 'none';
  updateChannelMenuBtn();
  renderFeedChannelStrip();
  renderFeed();
}

function renderFeedChannelStrip() {
  const strip = document.getElementById('channel-strip');
  if (!strip) return;
  const channels = discoverChannels();
  const pills = [];
  pills.push(`<button class="ch-pill${activeChannel === null ? ' active' : ''}" onclick="setActiveChannel(null)">Public</button>`);
  for (const ch of channels) {
    pills.push(`<button class="ch-pill${activeChannel === ch ? ' active' : ''}" onclick="setActiveChannel('${escHtml(ch)}')">#${escHtml(ch)}</button>`);
  }
  pills.push(`<button class="ch-pill ch-add" onclick="promptCreateChannel()" title="Create or join a channel">+</button>`);
  strip.innerHTML = pills.join('');
}

function promptCreateChannel() {
  const raw = prompt('Channel name (letters, numbers, _ and - only, max 32 chars):');
  if (!raw) return;
  const name = raw.trim().replace(/\s+/g, '-');
  if (!CHANNEL_NAME_RE.test(name)) { toast('Invalid channel name', 'error'); return; }
  setActiveChannel(name);
}

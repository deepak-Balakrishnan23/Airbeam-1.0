/**
 * One screen per machine state.
 *
 * Each builder returns { node, update } instead of just a node. The runtime
 * only rebuilds when the screen name changes and calls update() for everything
 * else, because the emitter canvas and the camera <video> live across renders -
 * tearing them down on every progress tick would restart the camera several
 * times a second. A builder that runs a clock also returns dispose(), which the
 * runtime calls on the way to the next screen.
 *
 * Steps that are only a question - which channel, is the other phone ready -
 * are views inside one state's screen rather than states of their own: the
 * machine has nothing to do until the answer is in.
 */

import { h, stat } from './dom.js'
import { formatBytes, formatDuration } from '../lib/bytes.js'
import { OPTICAL, WAVE } from '../config.js'
import { LADDER, PROFILES, layoutFor } from '../optical/airblock/grid.js'
import { capacityFor } from '../optical/airblock/frame.js'
import { Level } from '../optical/guidance.js'
import { FOUNTAIN_OVERHEAD } from '../optical/fountain.js'
import { Role } from '../state/events.js'

/**
 * What the screens remember between states, for this page only: the file last
 * picked (so a delivery can offer it again), the last delivery, and when the
 * running transfer started (so the finished screen can say how long it took).
 */
const memo = { file: null, recent: null, startedAt: 0 }

/**
 * What Wave carries, after each message's block header and CRC: 124 bytes of
 * file for every message and its gap.
 */
const WAVE_BYTES_PER_SECOND = Math.round((WAVE.messageBytes - 16) / (WAVE.messageSeconds + WAVE.gapSeconds))

/** No new blocks for this long, with the guide not reading, is a lost pattern. */
const LOST_AFTER_MS = 4000

// ------------------------------------------------------------------ numbers

/** Raw optical capacity of a rung, before any frame is lost. */
function rungRate(profile, parity = OPTICAL.parity) {
  const capacity = capacityFor(layoutFor(profile), parity)
  return { payloadBytes: capacity.payloadBytes, bytesPerSecond: capacity.payloadBytes * OPTICAL.frameRate }
}

/**
 * Rough wall-clock estimate.
 *
 * The multiplier is the fountain's measured overhead, and the UI calls the
 * number approximate because that overhead has a long tail. It also assumes
 * the camera reads every frame, which it will not. The honest number arrives
 * once the transfer is running and telemetry can report the real rate; until
 * then this is a lower bound presented as an estimate.
 */
function estimateMs(outgoing) {
  const frames = (outgoing.blocks * FOUNTAIN_OVERHEAD) / outgoing.blocksPerFrame
  // Floored at a second: "about 0 seconds" reads as broken, not fast.
  return Math.max(1000, (frames * 1000) / OPTICAL.frameRate)
}

/**
 * Wave's wall-clock estimate, whether it can run at all, and whether it is
 * short enough to offer without a warning. A file too big to have a Wave
 * encoder is still estimated, from its size, so the warning can say how long.
 */
function waveEstimate(outgoing) {
  const possible = Number.isFinite(outgoing.waveMessages)
  const ms = possible
    ? outgoing.waveMessages * (WAVE.messageSeconds + WAVE.gapSeconds) * 1000
    : (outgoing.size / WAVE_BYTES_PER_SECOND) * 1000
  return { ms, possible, fits: possible && ms <= WAVE.maxSeconds * 1000 }
}

/** Time left on a Wave receive, from the blocks still wanted. */
function waveTimeLeft(progress) {
  const want = progress?.need ? Math.round(progress.need * WAVE.overhead) : 0
  const left = Math.max(0, want - (progress?.have ?? 0))
  return left * (WAVE.messageSeconds + WAVE.gapSeconds) * 1000
}

/** A duration in one unit of words: "31 seconds", "4 minutes", "8 hours". */
function words(ms) {
  const s = Math.max(1, Math.round(ms / 1000))
  const [n, unit] = s < 90 ? [s, 'second'] : s < 90 * 60 ? [Math.round(s / 60), 'minute'] : [Math.round(s / 3600), 'hour']
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

const roughly = (ms) => `about ${words(ms)}`

/** Elapsed time as a stopwatch reads it: 0:12. */
function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Time left, from how long the fraction so far took. Null until there is enough to go on. */
function timeLeft(fraction, since) {
  if (fraction < 0.05 || !since) return null
  const spent = performance.now() - since
  return (spent / fraction) * (1 - fraction)
}

const leftText = (ms) => (ms === null ? '' : `about ${formatDuration(ms)} left`)
const percent = (fraction) => `${Math.round(fraction * 100)}%`
const channelWord = (mode) => ({ wave: 'sound', wifi: 'Wi-Fi' })[mode] ?? 'light'

/** Wi-Fi needs WebRTC, which every current browser has; the button hides where it does not. */
const wifiOk = () => typeof RTCPeerConnection === 'function'

/** A computer's window: the file beside the channel, the code beside its instructions. */
const wide = () => globalThis.matchMedia?.('(min-width: 900px)').matches ?? false

/** A phone or tablet: the one kind of device with a second camera worth offering. */
const onTouchDevice = () => globalThis.matchMedia?.('(pointer: coarse)').matches ?? false

// -------------------------------------------------------------------- parts

const brand = () => h('span', { class: 'brand' }, 'AIRBEAM')
const eyebrow = (text, tone = '') => h('div', { class: `eyebrow ${tone}` }, text)
const topbar = (left, right) => h('nav', { class: 'topbar' }, left ?? h('span', {}), right ?? null)
const backLink = (onclick) => h('button', { class: 'link dim', type: 'button', onclick }, 'Back')
const stepOf = (n) => h('span', { class: 'eyebrow' }, `STEP ${n} OF 2`)
const status = (text, tone) => h('span', { class: `status ${tone}` }, text)
const btn = (label, onclick, kind = '') => h('button', { class: `btn ${kind}`, type: 'button', onclick }, label)
const link = (label, onclick, kind = '') => h('button', { class: `link ${kind}`, type: 'button', onclick }, label)
const spacer = () => h('div', { class: 'spacer' })
const buttons = (...items) => h('div', { class: 'buttons' }, ...items)
const b = (text) => h('strong', {}, text)
const steps = (items, kind = '') => h('ol', { class: `steps ${kind}` }, ...items.map((item) => h('li', {}, h('span', {}, item))))
const bullets = (items, tone = '') => h('ul', { class: `bullets ${tone}` }, ...items.map((item) => h('li', {}, h('span', {}, item))))

/** A card with an amber title and a line under it; amber all over for the ones that need it now. */
const noteCard = (title, text, tone = 'warn') =>
  h('div', { class: `card ${tone}` }, h('div', { class: 'card-title warn' }, title), h('p', {}, text))

/** A button that opens the file chooser: a label round a hidden input. */
function filePicker(label, kind, onFile) {
  const input = h('input', {
    type: 'file',
    onchange: (event) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (file) onFile(file)
    },
  })
  return h('label', { class: kind }, input, label)
}

/**
 * Hand a file to the sender, from wherever the user is. The machine only takes
 * a file at idle, so every other screen goes back there first.
 */
function sendFile(actions, file) {
  memo.file = file
  actions.ui.set('seen', true)
  actions.reset()
  actions.pickFile(file)
}

/** The file's name and size, and its blocks and checksum when those are asked for. */
function fileCard(file, techy, blocks = `${file.blocks} block${file.blocks === 1 ? '' : 's'}`) {
  return h(
    'div',
    { class: 'card file' },
    h(
      'div',
      { class: 'file-row' },
      h('span', { class: 'file-name' }, file.name),
      h('span', { class: 'file-size' }, formatBytes(file.size)),
    ),
    techy ? meta(blocks, file.digest.slice(0, 16), 'tech') : null,
  )
}

function meta(left, right, kind = '') {
  return h('div', { class: `meta ${kind}` }, h('span', {}, left), h('span', {}, right))
}

/** Percentage, time left, a bar and a line under it - the one progress readout. */
function progressBlock(size = '') {
  const pct = h('span', { class: `pct ${size}` })
  const eta = h('span', {})
  const head = h('div', { class: 'pct-row' }, pct, eta)
  const fill = h('span', {})
  const bar = h('div', { class: 'bar' }, fill)
  const left = h('span', {})
  const right = h('span', {})
  return {
    node: h('div', { class: 'progress' }, head, bar, h('div', { class: 'meta' }, left, right)),
    set({ fraction, eta: etaText = '', left: l = '', right: r = '', tone = '', number = true }) {
      head.hidden = !number
      pct.textContent = percent(fraction)
      pct.classList.toggle('dim', tone === 'idle')
      eta.textContent = etaText
      fill.style.width = percent(fraction)
      bar.className = `bar ${tone}`
      left.textContent = l
      right.textContent = r
    },
  }
}

/** A row of bars that moves while a microphone or speaker is at work. */
const levelMeter = () => h('div', { class: 'meter', 'aria-hidden': 'true' }, ...Array.from({ length: 12 }, () => h('i', {})))

/**
 * Stop, asking first once there is something to lose.
 *
 * Nothing survives a stop - the machine drops the session on its way back to
 * idle - so the question says so, and carrying on is the easy answer.
 */
function stopper(actions, fraction, cost = '') {
  return () => {
    const f = fraction()
    if (!(f > 0)) return actions.reset()
    const carryOn = btn('Carry on', () => sheet.remove(), 'primary small')
    const sheet = h(
      'div',
      { class: 'sheet-back', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Stop the transfer?' },
      h(
        'div',
        { class: 'sheet' },
        h('div', { class: 'sheet-title' }, `Stop at ${percent(f)}?`),
        h(
          'p',
          {},
          `Nothing is kept. The next attempt starts from the first block${cost ? `, which takes ${cost}` : ''}.`,
        ),
        buttons(btn('Stop the transfer', actions.reset, 'danger small'), carryOn),
      ),
    )
    // Inside the app root, so the next screen clears it along with this one.
    document.getElementById('app')?.append(sheet)
    carryOn.focus()
  }
}

/**
 * Put the whole page on the display, from the tap that starts sending.
 *
 * Physical width is what decides the receiver's working distance: it needs
 * about 7 capture pixels per tile, so a code twice as wide can be read from
 * twice as far. The page rather than the canvas, so the status and Stop stay
 * with the code. Safari on an iPhone offers neither call and the panel is
 * already the phone's width there.
 */
function fullscreen() {
  const root = document.documentElement
  ;(root.requestFullscreen ?? root.webkitRequestFullscreen)?.call(root)?.catch?.(() => {})
}

function leaveFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
  else if (document.webkitFullscreenElement) document.webkitExitFullscreen?.()
}

/**
 * Optional capabilities that did not start.
 *
 * Named plainly rather than hidden: a transfer running without a focus lock or
 * without the back channel still works, but it works differently, and a user
 * wondering why it is slow deserves to know which.
 */
function degradedNote(machine) {
  const entries = Object.entries(machine.context.degraded ?? {})
  if (!entries.length) return null
  return h('div', { class: 'card warn compact' }, ...entries.map(([, reason]) => h('p', {}, reason)))
}

/** Swap a holder's contents for nodes, any of which may not exist. */
const put = (holder, ...nodes) => holder.replaceChildren(...nodes.flat().filter(Boolean))
const fill = put

// ---------------------------------------------------------- technical parts

/**
 * Throughput, reported honestly.
 *
 * Full span first, best window beside it. The gap between the two measures how
 * much of the channel is being lost to how the camera is being held rather than
 * to anything physical - and quoting only the good window makes an interaction
 * problem look like a solved one.
 */
function throughputStats(diagnostics) {
  if (!diagnostics) return null
  const span = diagnostics.fullSpanBytesPerSecond ?? 0
  const best = diagnostics.bestWindowBytesPerSecond ?? 0
  return h(
    'dl',
    {},
    stat('Rate (full span)', `${formatBytes(span)}/s`),
    best > 0 ? stat('Rate (best 5s)', `${formatBytes(best)}/s`) : null,
    diagnostics.aimingSpread > 1.05 ? stat('Lost to aiming', `${diagnostics.aimingSpread.toFixed(2)}x`) : null,
    stat(
      'Frames',
      `${diagnostics.framesDecoded} of ${diagnostics.framesCaptured} read` +
        (diagnostics.droppedForBackpressure ? ` (${diagnostics.droppedForBackpressure} skipped)` : ''),
    ),
    stat('Geometry found', `${(diagnostics.geometryYield * 100).toFixed(0)}% of frames`),
  )
}

/** What the aiming guide measured, and which densities this camera has been reading. */
function cameraStats(guidance, diagnostics) {
  const seen = diagnostics?.byDensity ?? {}
  const camera = diagnostics?.camera
  return h(
    'dl',
    {},
    guidance?.pxPerTile ? stat('Detail', `${guidance.pxPerTile.toFixed(1)} px per tile`) : null,
    guidance?.pxPerTile ? stat('Squareness', `${((1 - guidance.tilt) * 100).toFixed(0)}%`) : null,
    guidance?.pxPerTile ? stat('Confidence', `${(guidance.confidence * 100).toFixed(0)}%`) : null,
    camera ? stat('Camera', `${camera[0]} x ${camera[1]}`) : null,
    diagnostics?.workers ? stat('Decoders', String(diagnostics.workers)) : null,
    ...LADDER.filter((id) => seen[id]).map((id) => stat(`Density ${id}`, `${seen[id].read} of ${seen[id].seen} frames read`)),
  )
}

/** The numbers, what the lens choice costs, and the diagnostics file. */
function receiverDetails(actions, body) {
  const lens =
    actions.facing === 'environment'
      ? 'Back camera. It reads best, but the sender cannot see this screen, so it cycles ' +
        'through every density. The front camera lets the sender read a status code from ' +
        'this screen and pick the densest one this camera can manage.'
      : 'Front camera, so the sender can read the status code on this screen. The back ' +
        'camera reads a finer code.'
  return h(
    'details',
    { class: 'tech' },
    h('summary', {}, 'Technical details'),
    body,
    h('p', { class: 'hint left' }, lens),
    h(
      'p',
      { class: 'hint left' },
      'Diagnostics is a file of what the camera saw in every frame: how big and sharp the ' +
        'code was, and what decoded. It stays on this device until you send it on; it is ' +
        'what shows why a transfer was slow.',
    ),
    btn('Save diagnostics', actions.downloadTelemetry, 'small'),
  )
}

// ----------------------------------------------------------------- settings

function settingsPanel(actions) {
  const s = actions.settings
  const techy = actions.ui.get('details', false)
  const setting = (label, options, onchange, note) =>
    h(
      'label',
      { class: 'setting' },
      h('span', {}, label),
      h(
        'select',
        { onchange: (event) => onchange(event.target.value) },
        ...options.map(([value, text, selected]) => h('option', { value, selected }, text)),
      ),
      note ? h('span', { class: 'hint left' }, note) : null,
    )

  return h(
    'details',
    { class: 'settings' },
    h('summary', {}, h('span', {}, 'Transfer settings'), h('span', { class: 'mono faint' }, 'advanced')),
    h(
      'div',
      { class: 'settings-body' },
      setting(
        'Density',
        LADDER.map((id) => {
          const profile = PROFILES.find((p) => p.id === id)
          const rate = rungRate(id)
          return [
            id,
            `${id}: ${(rate.bytesPerSecond / 1024).toFixed(0)} KB/s, needs ${profile.pxPerTileAt720.toFixed(0)} px/tile`,
            s.profile === id,
          ]
        }),
        actions.setProfile,
        'Denser is faster but needs a sharper picture. The other device measures what it ' +
          'can actually read and moves this on its own.',
      ),
      /*
       * Turning the code is the receiver's problem stated on the sender's
       * screen: a phone held upright against a landscape panel can only fill
       * the short axis of its own capture, which costs 1.78x in capture pixels
       * per tile. The sender cannot detect it, so the person has to say.
       */
      setting(
        'Code on screen',
        [
          ['flat', 'Flat', !s.turned],
          ['upright', 'Upright', s.turned],
        ],
        (value) => actions.setTurned(value === 'upright'),
        'Upright suits a receiving phone held upright in front of a wide screen.',
      ),
      setting(
        'Technical details',
        [
          ['off', 'Hidden', !techy],
          ['on', 'Shown', techy],
        ],
        (value) => actions.ui.set('details', value === 'on'),
        'Block counts, checksums and what the camera measured, on the screens that have them.',
      ),
    ),
  )
}

/** The last delivery this page made, offered again. */
function recentList(onFile) {
  const recent = memo.recent
  if (!recent) return null
  return h(
    'div',
    { class: 'recent-list' },
    eyebrow('RECENT'),
    h(
      'div',
      { class: 'recent' },
      h(
        'div',
        { class: 'recent-text' },
        h('span', { class: 'file-name' }, recent.name),
        h('span', { class: 'mono mid' }, `sent by ${channelWord(recent.mode)} · ${formatBytes(recent.size)}`),
      ),
      link('Send again', () => onFile(recent.file)),
    ),
  )
}

/** Drop a file anywhere on a computer's page; a stray drop would otherwise open it in the tab. */
function acceptDrops(node, onFile) {
  node.addEventListener('dragover', (event) => {
    event.preventDefault()
    node.classList.add('dragging')
  })
  node.addEventListener('dragleave', (event) => {
    if (!node.contains(event.relatedTarget)) node.classList.remove('dragging')
  })
  node.addEventListener('drop', (event) => {
    event.preventDefault()
    node.classList.remove('dragging')
    const file = event.dataTransfer?.files?.[0]
    if (file) onFile(file)
  })
}

/** A computer's left half: what the app is, and where the file goes. */
function hero(onFile) {
  return h(
    'section',
    { class: 'hero' },
    brand(),
    h('h2', { class: 'xxl' }, 'Send a file to a phone in the room.'),
    h(
      'p',
      { class: 'lede' },
      'No account, no cable. Over the same Wi-Fi, or with no network at all: this screen flashes a pattern and the phone reads it with its camera.',
    ),
    filePicker(
      [h('span', { class: 'zone-title' }, 'Drop a file here'), h('span', { class: 'zone-text' }, 'or click to browse')],
      'dropzone',
      onFile,
    ),
    h(
      'p',
      { class: 'hint left' },
      h('strong', { class: 'warn-text' }, 'Light and sound are not encrypted. '),
      'Any camera or microphone nearby gets the same file. Wi-Fi is encrypted.',
    ),
  )
}

// ------------------------------------------------------------------ screens

function idleScreen(machine, actions) {
  const onFile = (file) => sendFile(actions, file)
  const receive = () => {
    actions.ui.set('seen', true)
    actions.chooseReceiver()
  }

  if (wide()) {
    const node = h(
      'div',
      { class: 'screen split' },
      hero(onFile),
      h(
        'aside',
        { class: 'side' },
        eyebrow('READY TO SEND', 'accent'),
        h('div', { class: 'card quiet' }, h('p', {}, 'No file yet. Drop one on the left, or click to browse.')),
        recentList(onFile),
        spacer(),
        settingsPanel(actions),
        link('Receiving something instead?', receive, 'dim center'),
      ),
    )
    acceptDrops(node, onFile)
    return { node, update() {} }
  }

  const node = h('div', { class: 'screen' })

  // The two-device model, stated before any action: nothing on a bare home
  // screen says a second phone has to be running the app too.
  const intro = (onBack) =>
    put(
      node,
      topbar(onBack ? backLink(onBack) : brand(), onBack ? brand() : null),
      h('h2', { class: 'xl' }, 'Move a file between two devices by Wi-Fi, light or sound.'),
      steps(
        [
          ['You need ', b('two devices, both with AirBeam open.')],
          'One sends, one receives. This one can do either.',
          'On the same Wi-Fi it is fastest. With no network, hold them facing each other.',
        ],
        'intro',
      ),
      noteCard(
        'Light and sound are not private',
        'By light or sound the file travels unencrypted, so another camera or microphone ' +
          'nearby could pick it up. Wi-Fi is encrypted.',
        '',
      ),
      spacer(),
      buttons(
        filePicker('Send a file', 'btn primary', onFile),
        btn('Receive a file', receive),
        h('p', { class: 'hint' }, 'Whoever has the file taps Send. The other taps Receive.'),
      ),
    )

  const home = () =>
    put(
      node,
      topbar(brand(), link('How it works', () => intro(home))),
      h('h2', { class: 'xl' }, 'What are you doing?'),
      filePicker(
        [
          h('span', { class: 'option-title' }, 'Send a file'),
          h('span', { class: 'option-text' }, 'Pick something and send it by Wi-Fi, light or sound.'),
        ],
        'option filled',
        onFile,
      ),
      h(
        'button',
        { class: 'option', type: 'button', onclick: receive },
        h('span', { class: 'option-title' }, 'Receive a file'),
        h('span', { class: 'option-text' }, 'Get ready for a file from the other device.'),
      ),
      recentList(onFile),
      spacer(),
      settingsPanel(actions),
    )

  if (actions.ui.get('seen', false)) home()
  else intro(null)
  return { node, update() {} }
}

/**
 * The file is picked; ask which way it travels, then get the other phone
 * ready before anything starts.
 *
 * Choosing and starting are separate taps, so tapping a channel is never a
 * guess about whether the transfer just began. On a phone each question is a
 * page; on a computer the file and the question sit side by side, and light
 * starts at once because its instructions sit beside the code.
 */
function choosingScreen(machine, actions) {
  const { outgoing } = machine.context
  const techy = actions.ui.get('details', false)
  const light = estimateMs(outgoing)
  const sound = waveEstimate(outgoing)
  const desk = wide()
  // Wi-Fi first when the browser has it: it is the fastest. A file past the
  // light and sound cap has only Wi-Fi.
  const airOk = outgoing.air !== false
  let choice = wifiOk() || !airOk ? 'wifi' : 'air'

  const flow = h('div', { class: 'flow' })
  const show = (view) => put(flow, view())

  const startLight = () => {
    fullscreen()
    actions.chooseMode('air')
  }
  const toLight = () => (desk ? startLight() : show(handoffLight))
  const toSound = () => show(sound.fits ? handoffSound : tooLong)
  const toWifi = () => show(handoffWifi)
  const next = () => (choice === 'air' ? toLight() : choice === 'wifi' ? toWifi() : toSound())
  const back = () => show(chooser)

  function chooser() {
    const cont = btn('', next, 'primary')
    const option = (mode, title, text, facts, badge) =>
      h(
        'button',
        { class: 'option', type: 'button', role: 'radio', onclick: () => select(mode), 'data-mode': mode },
        h(
          'span',
          { class: 'option-head' },
          h('span', { class: 'option-title' }, title),
          badge ? h('span', { class: 'badge' }, badge) : null,
        ),
        h('span', { class: 'option-text' }, text),
        h('span', { class: 'facts' }, ...facts.map((fact) => h('span', {}, fact))),
      )
    const group = h(
      'div',
      { class: 'options', role: 'radiogroup', 'aria-label': 'How it travels' },
      wifiOk()
        ? option(
            'wifi',
            'Over Wi-Fi',
            'Both on the same Wi-Fi. A short chirp connects them, then the file goes straight across.',
            ['same network', 'nothing to aim'],
            'FASTEST',
          )
        : null,
      airOk
        ? option(
            'air',
            'By light',
            'This screen flashes a pattern. The other phone reads it with its camera.',
            [roughly(light), 'needs a clear view'],
          )
        : null,
      airOk
        ? option(
            'wave',
            'By sound',
            'This phone plays the file as a tone. The other one listens. Nothing to aim.',
            [roughly(sound.ms), 'quiet room, close by'],
          )
        : null,
    )
    function select(mode) {
      choice = mode
      for (const card of group.children) card.setAttribute('aria-checked', String(card.dataset.mode === mode))
      cont.textContent = `Continue with ${channelWord(mode)}`
    }
    select(choice)

    return desk
      ? [
          eyebrow('READY TO SEND', 'accent'),
          fileCard(outgoing, techy),
          group,
          spacer(),
          cont,
          link(
            'Receiving something instead?',
            () => {
              actions.reset()
              actions.chooseReceiver()
            },
            'dim center',
          ),
        ]
      : [topbar(backLink(actions.reset), stepOf(1)), h('h2', {}, 'How should it travel?'), fileCard(outgoing, techy), group, spacer(), cont]
  }

  // The hand-off: read it aloud, set the other phone up, then start. The
  // flashing warning is consent given before the flashing, not a caption.
  const handoffLight = () => [
    topbar(backLink(back), stepOf(2)),
    h('h2', {}, 'Set up the other phone first.'),
    h(
      'div',
      { class: 'card roomy' },
      eyebrow('ON THE PHONE THAT IS RECEIVING', 'accent'),
      steps(['Open AirBeam', ['Tap ', b('Receive a file'), ', then ', b('By light')], "Point its camera at this screen, about a hand's width away"]),
    ),
    // 15 flashes a second sits in the photosensitive seizure risk band.
    noteCard(
      'This screen will flash quickly',
      'If flashing light affects you, look away once it starts, or send by sound instead.',
    ),
    spacer(),
    buttons(
      btn('The other phone is ready: start', startLight, 'primary'),
      sound.possible ? btn('Send by sound instead', toSound) : null,
    ),
  ]

  // Wi-Fi connects by a chirp each way, so both phones need sound on and the
  // other one has to be listening before this one starts.
  const handoffWifi = () => [
    topbar(backLink(back), stepOf(2)),
    h('h2', {}, 'Set up the other device first.'),
    h(
      'div',
      { class: 'card roomy' },
      eyebrow('ON THE DEVICE THAT IS RECEIVING', 'accent'),
      steps([
        'Join the same Wi-Fi as this one',
        ['Open AirBeam, tap ', b('Receive a file'), ', then ', b('Over Wi-Fi')],
        'Keep the two close, volume up: they connect with a short chirp',
      ]),
    ),
    spacer(),
    buttons(
      btn('The other device is listening: connect', () => actions.chooseMode('wifi'), 'primary'),
      airOk ? btn('Send by light instead', toLight) : null,
    ),
  ]

  // Before a single tone plays. Safari mutes Web Audio on the ringer switch
  // unless it supports the setting that says otherwise; wave.js sets it where
  // it exists, so the switch only needs mentioning where it does not.
  const handoffSound = () => {
    const check = (title, text, tone = '') =>
      h(
        'div',
        { class: `card check ${tone}` },
        h('span', { class: 'check-mark', 'aria-hidden': 'true' }, tone ? '!' : '✓'),
        h('div', { class: 'check-text' }, h('span', { class: 'check-title' }, title), h('span', {}, text)),
      )
    const checks = [
      check('Volume is up', "Turn this phone's volume most of the way up."),
      navigator.audioSession
        ? null
        : check('Is this phone on silent?', 'Flip the ringer switch off silent before starting, or nothing will be heard.', 'warn'),
      check("Phones within arm's reach", 'Speaker facing the other phone, quiet room'),
    ].filter(Boolean)
    return [
      topbar(backLink(back), stepOf(2)),
      h('h2', {}, `${checks.length === 3 ? 'Three' : 'Two'} things, then it plays.`),
      h('div', { class: 'checks' }, ...checks),
      h(
        'div',
        { class: 'card quiet' },
        eyebrow('ON THE PHONE THAT IS RECEIVING', 'accent'),
        h(
          'p',
          { class: 'body' },
          'Open AirBeam, tap ',
          b('Receive a file'),
          ', then ',
          b('By sound'),
          '. It will not hear anything until you start here.',
        ),
      ),
      spacer(),
      buttons(
        btn(`Play the file (${roughly(sound.ms)})`, () => actions.chooseMode('wave'), 'primary'),
        btn('Send by light instead', toLight),
      ),
    ]
  }

  // The limit in time rather than bytes a second, before the mistake rather
  // than after it.
  const tooLong = () => [
    topbar(backLink(back), stepOf(1)),
    h('h2', {}, "That's a long one by sound."),
    fileCard(outgoing, false),
    noteCard(
      `${roughly(sound.ms).replace('about', 'About')} of sound`,
      `Sound carries roughly ${WAVE_BYTES_PER_SECOND} bytes a second, so it suits notes, links and ` +
        'small documents. Both phones would have to sit still the whole time.',
    ),
    h(
      'div',
      { class: 'card chosen' },
      h('div', { class: 'option-title small' }, `By light: ${roughly(light)}`),
      h('p', { class: 'body' }, "Same file, read by the other phone's camera."),
    ),
    spacer(),
    buttons(
      btn('Send it by light', toLight, 'primary'),
      sound.possible ? btn('Use sound anyway', () => show(handoffSound), 'muted') : null,
    ),
  ]

  show(chooser)

  if (desk) {
    const node = h('div', { class: 'screen split' }, hero((file) => sendFile(actions, file)), h('aside', { class: 'side' }, flow))
    acceptDrops(node, (file) => sendFile(actions, file))
    return { node, update() {} }
  }
  return { node: h('div', { class: 'screen' }, flow), update() {} }
}

/**
 * Sending by light.
 *
 * Nothing is drawn over the code: text and buttons on top of it cost the
 * camera readable tiles. On a phone the status sits above it and progress
 * below; on a computer both sit in a panel beside it and the code keeps the
 * larger half of the display.
 *
 * The sender's own progress is frames emitted, which says nothing about what
 * arrived. When the back channel is up it reports the receiver's real
 * progress, and that is the only progress shown. Without it the screen says
 * so, and only after a fair chance to aim does it suggest anything else -
 * silence is also what a working receiver with its back to us looks like.
 */
function transferringSendScreen(machine, actions, surfaces) {
  const { outgoing } = machine.context
  const techy = actions.ui.get('details', false)
  const sound = waveEstimate(outgoing)
  const opened = performance.now()
  memo.startedAt = opened
  let latest = machine
  let firstRead = 0
  let nudgeFrom = opened

  const fraction = (m) => m.context.backchannel?.progress ?? 0

  const topStatus = h('span', {})
  const topClock = h('span', { class: 'mono mid', 'aria-hidden': 'true' })
  const topText = h('p', {})
  const top = h('div', { class: 'card top' }, h('div', { class: 'row-between' }, topStatus, topClock), topText)

  const progress = progressBlock()
  const waiting = h(
    'p',
    { class: 'hint left' },
    'Nothing has been read yet. Progress appears here the moment the other phone locks on.',
  )
  const stop = btn('Stop sending', stopper(actions, () => fraction(latest), roughly(estimateMs(outgoing))), 'small')

  const stalled = h(
    'div',
    { class: 'stalled' },
    h('div', { class: 'sheet-title' }, 'Still no sign of the other phone.'),
    h('p', { class: 'body' }, 'This screen is still sending. Check these three things:'),
    bullets([
      ['The other phone is on ', b('Receive'), ', with its camera open'],
      'Its camera can see this whole screen, not part of it',
      "Move closer, roughly a hand's width apart",
    ]),
    sound.fits
      ? [
          h('hr', {}),
          h(
            'p',
            {},
            'Light not working in this room? Sound is slower but needs no aiming. Both phones have to switch together.',
          ),
        ]
      : null,
    buttons(
      sound.fits ? btn('Switch us both to sound', () => actions.chooseMode('wave'), 'small') : null,
      btn(
        'Keep trying with light',
        () => {
          nudgeFrom = performance.now()
          paint(latest)
        },
        'primary small',
      ),
    ),
  )

  const degraded = h('div', {})
  const stats = h('dl', {})
  const bottom = h(
    'div',
    { class: 'card bottom' },
    progress.node,
    waiting,
    stalled,
    h(
      'div',
      { class: 'desk-only' },
      h(
        'div',
        { class: 'card' },
        eyebrow('ON THE PHONE', 'accent'),
        h('p', { class: 'body' }, "AirBeam → Receive a file → point the camera at this screen, about an arm's length away."),
      ),
      h(
        'div',
        { class: 'card warn' },
        h('p', {}, 'The pattern is flashing quickly. Look away from it if flashing light affects you.'),
      ),
    ),
    degraded,
    techy ? h('details', { class: 'tech' }, h('summary', {}, 'Technical details'), stats) : null,
    h('div', { class: 'grow' }),
    stop,
  )

  const node = h('div', { class: 'screen live sending' }, top, h('div', { class: 'stage' }, surfaces.canvas), bottom)

  function paint(next) {
    latest = next
    const heard = next.context.backchannel
    const f = fraction(next)
    const now = performance.now()
    const locked = f > 0 || (heard?.pxPerTile ?? 0) > 0
    if (f > 0 && !firstRead) firstRead = now
    const isStalled = !locked && now - nudgeFrom >= WAVE.nudgeAfterMs

    const tone = locked ? 'good' : 'warn'
    top.className = `card top ${tone}`
    topStatus.className = `status ${tone}`
    topStatus.textContent = locked ? 'The other phone is reading this' : isStalled ? 'Still sending' : 'Looking for the other phone'
    topClock.textContent = locked || isStalled ? '' : clock(now - opened)
    topText.className = locked ? 'headline' : 'body'
    topText.textContent = locked
      ? 'Hold both phones still.'
      : "Point the other phone's camera at this screen, close enough that the pattern fills its frame."
    topText.hidden = isStalled

    progress.set({
      fraction: f,
      number: locked,
      eta: leftText(timeLeft(f, firstRead)),
      left: outgoing.name,
      right: locked ? `${Math.round(f * outgoing.blocks)} of ${outgoing.blocks} blocks` : formatBytes(outgoing.size),
    })
    node.classList.toggle('stalled', isStalled)
    progress.node.hidden = isStalled
    waiting.hidden = locked || isStalled
    stalled.hidden = !isStalled
    stop.hidden = isStalled
    degraded.hidden = isStalled
    fill(degraded, degradedNote(next))

    if (techy) {
      const sent = next.context.progress ?? {}
      put(
        stats,
        stat('Frames sent', String(sent.framesShown ?? 0)),
        stat('Density', `${sent.profile ?? OPTICAL.profile}`),
        stat('Per frame', formatBytes(sent.payloadBytes ?? 0)),
        stat('Offered rate', `${formatBytes(sent.bytesPerSecond ?? 0)}/s`),
        stat('Render cost', `${(sent.renderMs ?? 0).toFixed(1)} ms per frame`),
        stat('Blocks', String(outgoing.blocks)),
        stat('Checksum', outgoing.digest.slice(0, 16)),
        heard ? stat('Its detail', `${(heard.pxPerTile ?? 0).toFixed(1)} px per tile`) : null,
        heard ? stat('Its confidence', `${Math.round((heard.confidence ?? 0) * 100)}%`) : null,
      )
    }
  }

  paint(machine)
  const ticker = setInterval(() => paint(latest), 1000)

  return {
    node,
    update: paint,
    dispose() {
      clearInterval(ticker)
      leaveFullscreen()
    },
  }
}

/**
 * Sending by sound.
 *
 * Sound has no back channel, so this side cannot know whether anything is
 * being heard; it says what it is doing and how long is left, and no more.
 */
function transferringSendWaveScreen(machine, actions) {
  const { outgoing } = machine.context
  const techy = actions.ui.get('details', false)
  const total = outgoing.waveMessages
  const each = (WAVE.messageSeconds + WAVE.gapSeconds) * 1000
  memo.startedAt = performance.now()
  let sent = 0

  const progress = progressBlock('huge')
  const degraded = h('div', {})
  // Sent, not heard - this side cannot know - so it stops short of full.
  const fraction = () => Math.min(0.99, sent / total)

  const paint = (next) => {
    sent = next.context.progress?.messagesSent ?? 0
    progress.set({
      fraction: fraction(),
      left: `${sent} of ${total} tones`,
      right: `${formatDuration(Math.max(0, total - sent) * each)} left`,
    })
    fill(degraded, degradedNote(next))
  }
  paint(machine)

  return {
    node: h(
      'div',
      { class: 'screen' },
      topbar(brand(), status('Playing', 'good')),
      progress.node,
      h(
        'div',
        { class: 'card tint' },
        status("Playing through this phone's speaker", 'good'),
        levelMeter(),
        h('p', {}, 'Keep both phones where they are and keep the room quiet.'),
      ),
      fileCard(outgoing, techy),
      degraded,
      spacer(),
      btn('Stop playing', stopper(actions, fraction, roughly(total * each))),
    ),
    update: paint,
  }
}

/**
 * The receiver's first question: the same three ways the sender was offered,
 * under the same names and in the same order, so "pick what they picked" is
 * all anyone needs to know.
 */
function choosingReceiveScreen(machine, actions) {
  const way = (mode, title, text, primary) =>
    h(
      'button',
      { class: `option${primary ? ' filled' : ''}`, type: 'button', onclick: () => actions.chooseMode(mode) },
      h('span', { class: 'option-head' }, h('span', { class: 'option-title' }, title)),
      h('span', { class: 'option-text' }, text),
    )
  return {
    node: h(
      'div',
      { class: 'screen' },
      topbar(backLink(actions.reset), brand()),
      h('h2', {}, 'Ready to receive.'),
      h('p', { class: 'lede' }, 'Pick the same way the other device picked.'),
      h(
        'div',
        { class: 'options' },
        wifiOk() ? way('wifi', 'Over Wi-Fi', 'Both on the same Wi-Fi. Keep the two close: they connect with a short chirp.', true) : null,
        way('air', 'By light', "Opens the camera. Hold this phone facing the other one's screen.", !wifiOk()),
        way('wave', 'By sound', 'Opens the microphone. Keep the two close in a quiet room.'),
      ),
      spacer(),
      h('p', { class: 'hint' }, 'The camera and microphone are only used to receive. Nothing is recorded or saved.'),
    ),
    update() {},
  }
}

/** The picture the decoder reads, with the frame to fit the code inside. */
function viewfinder(surfaces) {
  const reticle = h('div', { class: 'reticle' })
  return { node: h('div', { class: 'stage viewfinder' }, h('div', { class: 'frame' }, surfaces.video, reticle)), reticle }
}

/** Swap lenses. Named for where it points, so nobody needs to know which is which. */
function flipButton(actions) {
  if (!onTouchDevice()) return null
  const label = () => (actions.facing === 'environment' ? 'Front camera' : 'Back camera')
  const button = btn(label(), async () => {
    await actions.flipCamera()
    button.textContent = label()
  }, 'small')
  return button
}

/**
 * The receiver, camera open, nothing arriving yet.
 *
 * This screen is the highest-leverage one in the app. The measured spread
 * between a well-aimed capture and a badly-aimed one is larger than any
 * decode-side improvement, so telling someone plainly that they are too far
 * away is worth more than any amount of extra error correction. It is a state
 * that changes as the camera closes in, not a box that reads as an error.
 */
function aimingScreen(machine, actions, surfaces) {
  const techy = actions.ui.get('details', false)
  const opened = performance.now()
  let latest = machine

  const topStatus = h('span', {})
  const topClock = h('span', { class: 'mono mid', 'aria-hidden': 'true' })
  const top = h('div', { class: 'card top' }, h('div', { class: 'row-between' }, topStatus, topClock))
  const view = viewfinder(surfaces)
  const title = h('div', { class: 'headline' })
  const text = h(
    'p',
    { class: 'body' },
    'Move closer until the flashing pattern reaches the edges of the box, and hold the phone square to it.',
  )
  // Sound needs both devices to switch, since this one only opened its camera.
  const nudge = link('The other phone is sending sound', () => actions.chooseMode('wave'), 'center')
  const degraded = h('div', {})
  const details = h('div', {})
  const flip = flipButton(actions)

  const bottom = h(
    'div',
    { class: 'card bottom' },
    title,
    text,
    degraded,
    h('div', { class: 'grow' }),
    h('div', { class: 'pair' }, flip, btn('Cancel', actions.reset, 'small')),
    nudge,
    techy ? receiverDetails(actions, details) : null,
  )

  const paint = (next) => {
    latest = next
    const guidance = next.context.guidance
    const reading = guidance?.level === Level.GOOD
    const tone = reading ? 'good' : 'warn'
    top.className = `card top ${tone}`
    topStatus.className = `status ${tone}`
    topStatus.textContent = reading
      ? 'Reading'
      : guidance?.level === Level.ADVICE
        ? 'Almost there'
        : 'Looking for a pattern'
    topClock.textContent = clock(performance.now() - opened)
    view.reticle.className = `reticle ${reading ? 'locked' : ''}`
    title.textContent = guidance?.message || 'Fill the frame with the other screen.'
    text.hidden = Boolean(guidance?.pxPerTile)
    nudge.hidden = performance.now() - opened < WAVE.nudgeAfterMs
    fill(degraded, degradedNote(next))
    if (techy) details.replaceChildren(cameraStats(guidance, next.context.diagnostics))
  }

  paint(machine)
  const ticker = setInterval(() => paint(latest), 1000)

  return {
    node: h('div', { class: 'screen live camera' }, top, view.node, bottom),
    update: paint,
    dispose: () => clearInterval(ticker),
  }
}

/**
 * The receiver, blocks arriving.
 *
 * The frame turns teal on lock, and both phones show the same percentage. A
 * hand wobble is named rather than silently dropped back to searching, and
 * says the blocks already read are kept, because they are: the reassembler
 * lives until the machine goes back to idle.
 */
function transferringReceiveScreen(machine, actions, surfaces) {
  const techy = actions.ui.get('details', false)
  memo.startedAt = performance.now()
  let latest = machine
  let firstAt = 0
  let lastHave = -1
  let movedAt = performance.now()
  let current = 0

  const topStatus = h('span', {})
  const headline = h('div', { class: 'headline' })
  const top = h('div', { class: 'card top' }, topStatus, headline)
  const view = viewfinder(surfaces)
  const progress = progressBlock()
  const kept = h('p', { class: 'body' })

  // The status code only helps when this screen faces the sender, which means
  // the front camera; behind the back camera it would only push Cancel down.
  const beacon =
    actions.facing === 'user'
      ? h(
          'div',
          { class: 'beacon-wrap' },
          surfaces.beacon,
          h('p', { class: 'hint' }, 'Keep this small code facing the other phone. It tells it how the transfer is going.'),
        )
      : null

  const cancel = btn('Cancel', stopper(actions, () => current), 'small')
  const giveUp = btn('Give up and start over', actions.reset, 'small')
  const degraded = h('div', {})
  const details = h('div', {})

  const bottom = h(
    'div',
    { class: 'card bottom' },
    kept,
    progress.node,
    beacon,
    h(
      'p',
      { class: 'hint left desk-only' },
      'When it arrives, Save puts it in Downloads. Keep the phone inside the teal frame until it says it has arrived.',
    ),
    degraded,
    techy ? receiverDetails(actions, details) : null,
    h('div', { class: 'grow' }),
    cancel,
    giveUp,
  )

  const paint = (next) => {
    latest = next
    const now = performance.now()
    const p = next.context.progress ?? {}
    const have = p.have ?? 0
    // Against the fountain's real requirement, not against k - see
    // FOUNTAIN_OVERHEAD. Capped below 1 because the only thing that means
    // "done" is the machine leaving this state, and an unlucky run legitimately
    // collects more blocks than the median estimate.
    const want = p.need ? Math.round(p.need * FOUNTAIN_OVERHEAD) : 0
    current = want ? Math.min(0.99, have / want) : 0
    if (have !== lastHave) {
      lastHave = have
      movedAt = now
    }
    if (current > 0 && !firstAt) firstAt = now
    const lost = now - movedAt > LOST_AFTER_MS && next.context.guidance?.level !== Level.GOOD

    const tone = lost ? 'warn' : 'good'
    top.className = `card top ${tone}`
    topStatus.className = `status ${tone}`
    topStatus.textContent = lost ? 'Lost the pattern' : 'Reading'
    headline.textContent = lost ? 'Point back at the other screen.' : 'Hold it right there.'
    view.reticle.className = `reticle ${lost ? 'lost' : 'locked'}`

    kept.hidden = !lost
    kept.textContent = `The ${have} blocks already read are safe. Line the pattern up again and it carries on from there.`
    progress.set(
      lost
        ? { fraction: current, number: false, tone: 'warn', left: `${percent(current)} kept`, right: `waiting ${clock(now - movedAt)}` }
        : {
            fraction: current,
            eta: leftText(timeLeft(current, firstAt)),
            left: 'Receiving a file',
            right: want ? `${have} of ${want} blocks` : 'reading the first frames',
          },
    )
    cancel.hidden = lost
    giveUp.hidden = !lost
    fill(degraded, degradedNote(next))

    if (techy) {
      const stats = next.context.diagnostics
      details.replaceChildren(
        throughputStats(stats) ?? h('span', {}),
        cameraStats(next.context.guidance, stats),
        h('dl', {}, stat('Blocks solved', String(p.solved ?? 0))),
      )
    }
  }

  paint(machine)
  const ticker = setInterval(() => paint(latest), 1000)

  return {
    node: h('div', { class: 'screen live camera' }, top, view.node, bottom),
    update: paint,
    dispose: () => clearInterval(ticker),
  }
}

/**
 * The receiver on sound: the microphone open, waiting or hearing.
 *
 * Minutes of waiting, so it shows that the microphone is live and how much is
 * left rather than a sentence and nothing else.
 */
function hearingScreen(machine, actions) {
  memo.startedAt = performance.now()
  let current = 0

  const heading = h('h2', {})
  const progress = progressBlock('huge')
  const heard = h('span', {})
  const help = h('p', { class: 'body' })
  const degraded = h('div', {})

  const paint = (next) => {
    const p = next.context.progress ?? {}
    const have = p.have ?? 0
    const want = p.need ? Math.round(p.need * WAVE.overhead) : 0
    current = want ? Math.min(0.99, have / want) : 0
    heading.textContent = have ? 'Hearing the other phone.' : 'Listening for the other phone.'
    heard.textContent = have ? `${have} tones heard` : 'microphone on'
    progress.set({
      fraction: current,
      left: 'Receiving a file',
      right: want ? `${formatDuration(waveTimeLeft(p))} left` : 'waiting to start',
    })
    help.textContent = have
      ? 'Leave both phones where they are. This screen stays on while it listens.'
      : "Start playing on the other phone. Keep the two within arm's reach, with its volume up."
    fill(degraded, degradedNote(next))
  }
  paint(machine)

  return {
    node: h(
      'div',
      { class: 'screen' },
      topbar(brand(), status('Listening', 'good')),
      heading,
      h(
        'div',
        { class: 'card tint roomy' },
        levelMeter(),
        h('div', { class: 'meta' }, heard, h('span', {}, 'keep the room quiet')),
      ),
      progress.node,
      help,
      degraded,
      spacer(),
      buttons(
        btn('Stop listening', stopper(actions, () => current)),
        link('The other phone is sending by light', () => actions.chooseMode('air'), 'dim center'),
      ),
    ),
    update: paint,
  }
}

/**
 * Wi-Fi, on either side: the chirped hello, then a progress bar in bytes a
 * second. The match number is what tells two people they reached each other
 * and not some other device in earshot.
 */
function wifiScreen(machine, actions) {
  const sending = machine.role === Role.SENDER
  memo.startedAt = performance.now()
  let current = 0

  const heading = h('h2', {})
  const progress = progressBlock('huge')
  const help = h('p', { class: 'body' })
  const degraded = h('div', {})
  // Nothing is sent until the person sending has compared the numbers.
  const send = btn('Yes, the numbers match: send', actions.confirmWifi, 'primary')

  const paint = (next) => {
    const p = next.context.progress ?? {}
    const checking = p.phase === 'confirm'
    const size = p.size ?? next.context.outgoing?.size ?? 0
    const moved = p.sent ?? p.have ?? 0
    const moving = p.phase === 'sending' || p.phase === 'receiving'
    // Handed to the network is not arrived, so the sender stops short of full.
    current = size ? Math.min(sending ? 0.99 : 1, moved / size) : 0
    heading.textContent = moving
      ? sending ? 'Sending over Wi-Fi.' : 'Receiving over Wi-Fi.'
      : checking
        ? sending ? `Does the other screen show ${p.match}?` : `This screen shows ${p.match}.`
        : p.phase === 'connecting'
        ? 'Connecting.'
        : sending ? 'Saying hello to the other device.' : 'Listening for the other device.'
    progress.set({
      fraction: current,
      number: moving,
      left: p.match ? `match ${p.match}` : 'Wi-Fi',
      right: moving && p.rate ? `${formatBytes(p.rate)}/s` : '',
    })
    help.textContent = checking
      ? sending
        ? `Connected. Send only if the other device also shows ${p.match}; a different number means another device answered.`
        : `Connected. This screen shows ${p.match}; the file starts once the sender sees the same number and confirms.`
      : p.match
        ? `Both screens should show match ${p.match}. If the other one does not, stop here.`
      : sending
        ? 'Keep the two close with the volume up. They connect with a short chirp.'
        : 'Start sending on the other device, over Wi-Fi. Keep the two close.'
    send.hidden = !(sending && checking)
    fill(degraded, degradedNote(next))
  }
  paint(machine)

  return {
    node: h(
      'div',
      { class: 'screen' },
      topbar(brand(), status('Wi-Fi', 'good')),
      heading,
      progress.node,
      help,
      degraded,
      spacer(),
      buttons(send, btn(sending ? 'Stop sending' : 'Stop', stopper(actions, () => current))),
    ),
    update: paint,
  }
}

function verifyingScreen() {
  return {
    node: h(
      'div',
      { class: 'screen' },
      topbar(brand(), status('Checking', 'warn')),
      h('h2', {}, 'Checking the file.'),
      h('p', { class: 'lede' }, 'Every block arrived. Comparing it against the checksum that travelled with it.'),
    ),
    update() {},
  }
}

/** How the finished file travelled, and how long it took. */
function tookLine(mode, confirmed) {
  const took = memo.startedAt ? performance.now() - memo.startedAt : 0
  return h(
    'div',
    { class: 'meta' },
    h('span', {}, `by ${channelWord(mode)}${took ? ` · ${words(took)}` : ''}`),
    confirmed ? h('span', { class: 'accent' }, 'verified') : h('span', {}),
  )
}

/**
 * The sender's ending, read back from the receiving phone rather than
 * guessed: the only way here is the receiver's status code saying it has the
 * whole file.
 */
function deliveredScreen(machine, actions) {
  const { outgoing, confirmed, mode } = machine.context
  const techy = actions.ui.get('details', false)
  if (confirmed && memo.file) memo.recent = { file: memo.file, name: outgoing.name, size: outgoing.size, mode }

  return {
    node: h(
      'div',
      { class: 'screen' },
      h('div', { class: `done-mark ${confirmed ? '' : 'quiet'}`, 'aria-hidden': 'true' }, confirmed ? '✓' : '·'),
      h('h2', { class: 'xl' }, confirmed ? 'Delivered.' : 'Stopped sending.'),
      h(
        'p',
        { class: 'lede' },
        confirmed
          ? mode === 'wifi'
            ? 'The other device has every byte, over an encrypted link.'
            : 'The other phone has the whole file and checked it against the original.'
          : 'The other phone never confirmed, so check that it has the file.',
      ),
      h(
        'div',
        { class: 'card file' },
        h('div', { class: 'file-row' }, h('span', { class: 'file-name' }, outgoing.name), h('span', { class: 'file-size' }, formatBytes(outgoing.size))),
        tookLine(mode, confirmed),
        techy ? meta(`${outgoing.blocks} of ${outgoing.blocks} blocks`, outgoing.digest.slice(0, 16), 'tech') : null,
      ),
      spacer(),
      buttons(filePicker('Send another file', 'btn primary', (file) => sendFile(actions, file)), btn('Done', actions.reset)),
    ),
    update() {},
  }
}

function receivedScreen(machine, actions) {
  const { incoming, diagnostics, mode, progress } = machine.context
  const techy = actions.ui.get('details', false)

  /**
   * A real anchor, not a button that synthesises a click.
   *
   * The automatic download was the last thing standing between a completed
   * transfer and a file the user actually has. iOS Safari ignores a
   * programmatic click outside a user gesture, and can answer a blob URL by
   * navigating to it - which unloads the app, which is why a finished transfer
   * appeared for a moment and then went back to the aiming screen. A link the
   * user taps is a plain gesture-driven navigation and neither rule applies.
   */
  const saved = actions.fileUrl(incoming)
  // The sender only hears about it through the status code, which only the
  // front camera leaves facing it.
  const told = mode === 'wifi' || (mode !== 'wave' && actions.facing === 'user')
  const blocks = progress?.need ?? 0

  return {
    dispose: saved.revoke,
    node: h(
      'div',
      { class: 'screen' },
      h('div', { class: 'done-mark', 'aria-hidden': 'true' }, '✓'),
      h('h2', { class: 'xl' }, "It's here."),
      h(
        'p',
        { class: 'lede' },
        `${mode === 'wifi' ? 'Every byte arrived, over an encrypted link.' : 'Every block arrived and matches the original.'}${told ? ' The other device has been told.' : ''}`,
      ),
      h(
        'div',
        { class: 'card file' },
        h('div', { class: 'file-row' }, h('span', { class: 'file-name' }, incoming.name), h('span', { class: 'file-size' }, formatBytes(incoming.size))),
        tookLine(mode, true),
        techy ? meta(blocks ? `${blocks} of ${blocks} blocks` : incoming.type || 'unknown type', incoming.digest.slice(0, 16), 'tech') : null,
      ),
      techy && diagnostics
        ? h(
            'details',
            { class: 'tech' },
            h('summary', {}, 'How it went'),
            throughputStats(diagnostics),
            btn('Save diagnostics', actions.downloadTelemetry, 'small'),
          )
        : null,
      spacer(),
      buttons(
        h(
          'a',
          { class: 'btn primary', href: saved.url, download: incoming.name || 'airbeam-file' },
          wide() ? 'Save to this computer' : 'Save to this phone',
        ),
        h('a', { class: 'btn', href: saved.url, target: '_blank', rel: 'noopener' }, 'Open it'),
        h(
          'div',
          { class: 'row-between' },
          filePicker('Send something back', 'link', (file) => sendFile(actions, file)),
          link('Done', actions.reset, 'dim'),
        ),
      ),
    ),
    update() {},
  }
}

function failedScreen(machine, actions) {
  const { role, context } = machine
  // Either side can go on where it stopped - a sender still holds the file and
  // its encoder, a receiver its reassemblers - or try the other channel.
  const other = context.mode === 'air' ? 'wave' : 'air'
  const canResume = context.mode && (role === Role.RECEIVER || (role === Role.SENDER && context.outgoing))

  // A receiver that failed before a single block arrived on light could not
  // use the camera: a refusal used to look exactly like bad aim.
  if (role === Role.RECEIVER && context.mode === 'air' && !context.progress) {
    return {
      node: h(
        'div',
        { class: 'screen' },
        topbar(backLink(actions.reset), brand()),
        h('h2', {}, "AirBeam can't use the camera."),
        h(
          'p',
          { class: 'lede' },
          'Receiving by light needs it. Allow it for this page, or have the file sent by sound instead.',
        ),
        h(
          'div',
          { class: 'card roomy' },
          eyebrow('TO TURN IT ON', 'accent'),
          h('p', { class: 'body' }, "Allow camera access for this page in the browser's settings, then try again."),
          context.fault ? h('p', { class: 'hint left' }, context.fault) : null,
        ),
        spacer(),
        buttons(
          btn('Try again', () => actions.chooseMode('air'), 'primary'),
          btn('Receive by sound instead', () => actions.chooseMode('wave')),
        ),
      ),
      update() {},
    }
  }

  const retry =
    role === Role.SENDER && context.outgoing && context.mode
      ? context.outgoing.air !== false && (other === 'air' || waveEstimate(context.outgoing).fits)
        ? btn(`Try ${channelWord(other)} instead`, () => actions.chooseMode(other))
        : null
      : role === Role.RECEIVER && context.mode
        ? btn(`Try ${channelWord(other)} instead`, () => actions.chooseMode(other))
        : null

  return {
    node: h(
      'div',
      { class: 'screen' },
      topbar(brand(), status('Stopped', 'bad')),
      h('h2', {}, 'That did not work.'),
      h('p', { class: 'lede' }, context.fault || 'Something went wrong.'),
      spacer(),
      buttons(
        canResume ? btn('Keep going', () => actions.chooseMode(context.mode), 'primary') : null,
        retry,
        btn('Start over', actions.reset, canResume || retry ? '' : 'primary'),
      ),
    ),
    update() {},
  }
}

const BUILDERS = {
  idle: idleScreen,
  aiming: aimingScreen,
  listening: hearingScreen,
  choosing: choosingScreen,
  'choosing-receive': choosingReceiveScreen,
  'transferring-send': transferringSendScreen,
  'transferring-send-wave': transferringSendWaveScreen,
  'transferring-receive': transferringReceiveScreen,
  'transferring-receive-wave': hearingScreen,
  wifi: wifiScreen,
  verifying: verifyingScreen,
  delivered: deliveredScreen,
  received: receivedScreen,
  failed: failedScreen,
}

export function buildScreen(name, machine, actions, surfaces) {
  const builder = BUILDERS[name]
  if (!builder) {
    return {
      node: h('div', { class: 'screen' }, topbar(brand()), h('h2', {}, `No screen for "${name}".`)),
      update() {},
    }
  }
  return builder(machine, actions, surfaces)
}

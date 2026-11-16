// pong.js, put me into jsui object.
//
// Inlet 0: bang = advance one frame, reset = reset score, pos = from [transport]
// Inlet 1: left paddle  (live.slider 0..127)
// Inlet 2: right paddle (live.slider 0..127)
// Outlet 0: 
//   hit mode: "left", "right", "wall", "goal"
//   y / x mode: "midi <pitch> <velocity>" legato notes, one per step (1..12)
//   all modes: "cc 1 <0..127>" = y step, "cc 2 <0..127>" = x step

autowatch = 1;
inlets = 3;
outlets = 1;

mgraphics.init();
mgraphics.relative_coords = 0;
mgraphics.autofill = 0;

// ---------- settings ----------
var PADDLE_H = 0.28;      // paddle height (fraction of field height)
var PADDLE_W = 0.02;      // paddle width (fraction of field width)
var BALL = 0.05;          // ball size (fraction of field height)
var CYCLE = 4;            // beats for a round trip: left on 1, right on 3
var Y_SPEED = 0.6;        // typical vertical speed, field heights per second
var SLIDER_MAX = 127;


// ---------- state ----------
var X_LEFT = PADDLE_W * 2 + 0.015;   // ball centre when touching the left paddle
var X_RIGHT = 1 - X_LEFT;

var leftY = 0.5, rightY = 0.5;
var by = 0.5, vy = 0;
var scoreL = 0, scoreR = 0;

var phase = 0;            // position in the 4-beat cycle (0..CYCLE)
var tempo = 120;
var tPhase = 0;           // latest phase reported by the transport
var posKey = -1, lastPosKey = -1, stillMs = 1000;
var lastTime = 0;
var lastDraw = 0;
var DRAW_INTERVAL_MS = 16;   // ~60 fps redraw, independent of the metro rate
var flash = 0;            // seconds of screen flash left after a goal

// Output mode (from live.menu "hit y x" -> [prepend mode])
//   0 = hit: "left", "right", "wall", "goal"
//   1 = y:   "step 1..12" whenever the ball's vertical step changes (12 = top)
//   2 = x:   "step 1..12" whenever the ball's horizontal step changes (1 = left)
var STEPS = 12;
var STEP_BASE_NOTE = 60;   // step 1 = C3 (60), step 12 = B3 (71)
var STEP_VELOCITY = 100;
var mode_ = 0;
var lastStep = -1;
var lastPitch = -1;        // currently sounding step note (legato), -1 = none

// Continuous controllers, sent in every mode: y -> CC 1, x -> CC 2
// 12 steps spread over 0..127, sent only when the step changes
var CC_X = 2, CC_Y = 1;
var lastCCX = -1, lastCCY = -1;

// ---------- helpers ----------
function randomVy() {
    var v = (Math.random() * 2 - 1) * Y_SPEED;
    if (Math.abs(v) < 0.15) v = v < 0 ? -0.15 : 0.15;
    return v;
}

function sliderToY(v) {
    v = Math.max(0, Math.min(1, v));
    return PADDLE_H / 2 + (1 - v) * (1 - PADDLE_H);
}

function ballX() {
    var half = CYCLE / 2;
    if (phase < half) return X_LEFT + (X_RIGHT - X_LEFT) * (phase / half);
    return X_RIGHT - (X_RIGHT - X_LEFT) * ((phase - half) / half);
}

// only send hit events in "hit" mode
function emit(sym) {
    if (mode_ === 0) outlet(0, sym);
}

function quantize(v) {   // v in 0..1 -> 1..STEPS
    var s = 1 + Math.floor(v * STEPS);
    return Math.max(1, Math.min(STEPS, s));
}

function outputSteps() {
    if (mode_ === 0) return;
    var s;
    if (mode_ === 1) s = quantize(1 - by);   // top = 12
    else s = quantize((ballX() - X_LEFT) / (X_RIGHT - X_LEFT));
    if (s !== lastStep) {
        lastStep = s;
        // legato: release the previous note, then start the new one
        var pitch = STEP_BASE_NOTE + s - 1;
        if (lastPitch >= 0) outlet(0, "midi", lastPitch, 0);
        outlet(0, "midi", pitch, STEP_VELOCITY);
        lastPitch = pitch;
    }
}

function stepToCC(s) {
    return Math.round((s - 1) * 127 / (STEPS - 1));
}

function outputCCs() {
    var cx = stepToCC(quantize((ballX() - X_LEFT) / (X_RIGHT - X_LEFT)));
    var cy = stepToCC(quantize(1 - by));   // top = 127
    if (cx !== lastCCX) { lastCCX = cx; outlet(0, "cc", CC_X, cx); }
    if (cy !== lastCCY) { lastCCY = cy; outlet(0, "cc", CC_Y, cy); }
}

function stopStepNote() {
    if (lastPitch >= 0) outlet(0, "midi", lastPitch, 0);
    lastPitch = -1;
    lastStep = -1;
}

// ---------- messages ----------
function mode(m) {
    stopStepNote();   // release any held note before switching
    mode_ = Math.max(0, Math.min(2, Math.floor(m)));
}

// "stop" message: release the held step note (e.g. from a panic button)
function stop() {
    stopStepNote();
}

function reset() {
    scoreL = 0;
    scoreR = 0;
    by = 0.5;
    vy = randomVy();
    mgraphics.redraw();
}

// from [transport] -> [pack 0 0 0 0 0.] -> [prepend pos]
function pos(bars, beats, units, res, t) {
    if (t > 0) tempo = t;
    if (!(res > 0)) res = 480;
    tPhase = (beats - 1) + units / res;
    posKey = bars * 100000 + beats * 1000 + units;
}

function setPaddle(v) {
    var n = v / SLIDER_MAX;
    if (inlet === 1) leftY = sliderToY(n);
    else if (inlet === 2) rightY = sliderToY(n);
    mgraphics.redraw();
}

function msg_float(v) { setPaddle(v); }
function msg_int(v)   { setPaddle(v); }

// ---------- game ----------
function checkHit(side) {
    var paddleY = side === "left" ? leftY : rightY;
    if (Math.abs(by - paddleY) <= PADDLE_H / 2 + BALL / 2) {
        // hit: edge hits send the ball off at a steeper angle
        vy += (by - paddleY) * 3;
        var maxVy = Y_SPEED * 1.6;
        if (vy > maxVy) vy = maxVy;
        if (vy < -maxVy) vy = -maxVy;
        emit(side);
    } else {
        // miss: point for the other side, re-serve from the middle height
        if (side === "left") scoreR++;
        else scoreL++;
        flash = 0.15;
        by = 0.5;
        vy = randomVy();
        emit("goal");
    }
}

function bang() {
    if (inlet !== 0) return;

    var now = Date.now();
    var dt = lastTime ? Math.min(0.1, (now - lastTime) / 1000) : 0;
    lastTime = now;

    // is Live's transport running? (position changed recently)
    if (posKey !== lastPosKey) { stillMs = 0; lastPosKey = posKey; }
    else stillMs += dt * 1000;
    var playing = stillMs < 60;

    // advance the beat phase
    var prev = phase;
    if (playing) phase = tPhase % CYCLE;
    else phase = (phase + dt * tempo / 60) % CYCLE;

    // paddle contacts: beat 1 (cycle wraps) and beat 3 (crosses the half)
    var half = CYCLE / 2;
    if (phase < prev && prev - phase > half) checkHit("left");
    else if (prev < half && phase >= half && phase - prev < half) checkHit("right");

    // vertical motion + walls
    by += vy * dt;
    var r = BALL / 2;
    if (by < r)     { by = r;     vy = -vy; emit("wall"); }
    if (by > 1 - r) { by = 1 - r; vy = -vy; emit("wall"); }

    outputSteps();
    outputCCs();

    if (flash > 0) flash -= dt;

    // logic runs every metro tick, but only redraw ~60 times per second
    if (now - lastDraw >= DRAW_INTERVAL_MS) {
        lastDraw = now;
        mgraphics.redraw();
    }
}

// ---------- drawing ----------
function paint() {
    var s = mgraphics.size;
    var w = s[0], h = s[1];

    // background (flashes briefly on a goal)
    if (flash > 0) mgraphics.set_source_rgba(0.35, 0.35, 0.35, 1);
    else mgraphics.set_source_rgba(0.08, 0.08, 0.08, 1);
    mgraphics.rectangle(0, 0, w, h);
    mgraphics.fill();

    mgraphics.set_source_rgba(1, 1, 1, 1);

    // dashed centre line
    for (var y = 0; y < h; y += 10) mgraphics.rectangle(w / 2 - 1, y, 2, 5);
    mgraphics.fill();

    // paddles
    mgraphics.rectangle(PADDLE_W * w, (leftY - PADDLE_H / 2) * h, PADDLE_W * w, PADDLE_H * h);
    mgraphics.rectangle((1 - PADDLE_W * 2) * w, (rightY - PADDLE_H / 2) * h, PADDLE_W * w, PADDLE_H * h);
    mgraphics.fill();

    // ball
    var bs = BALL * h;
    mgraphics.rectangle(ballX() * w - bs / 2, by * h - bs / 2, bs, bs);
    mgraphics.fill();

    // score in pixel digits
    var cell = Math.max(2, Math.round(h / 40));
    drawNumber(scoreL, w * 0.25, cell * 2, cell);
    drawNumber(scoreR, w * 0.75, cell * 2, cell);
}

// ---------- pixel digits (3 x 6 grid) ----------
var DIGITS = {
    "0": ["###", "#.#", "#.#", "#.#", "#.#", "###"],
    "1": ["..#", "..#", "..#", "..#", "..#", "..#"],
    "2": ["###", "..#", "..#", "###", "#..", "###"],
    "3": ["###", "..#", "..#", ".##", "..#", "###"],
    "4": ["#.#", "#.#", "#.#", "###", "..#", "..#"],
    "5": ["###", "#..", "#..", "###", "..#", "###"],
    "6": ["#..", "#..", "#..", "###", "#.#", "###"],
    "7": ["###", "..#", "..#", "..#", "..#", "..#"],
    "8": ["###", "#.#", "#.#", "###", "#.#", "###"],
    "9": ["###", "#.#", "#.#", "###", "..#", "..#"]
};

// draws a number centred on cx, top at y, each pixel cell x cell
function drawNumber(n, cx, y, cell) {
    var str = String(n);
    var digitW = 3 * cell, gap = cell * 2;
    var totalW = str.length * digitW + (str.length - 1) * gap;
    var x = Math.round(cx - totalW / 2);
    for (var i = 0; i < str.length; i++) {
        var rows = DIGITS[str.charAt(i)];
        if (rows) {
            for (var r = 0; r < 6; r++) {
                for (var c = 0; c < 3; c++) {
                    if (rows[r].charAt(c) === "#") {
                        mgraphics.rectangle(x + c * cell, y + r * cell, cell, cell);
                    }
                }
            }
        }
        x += digitW + gap;
    }
    mgraphics.fill();
}

reset();
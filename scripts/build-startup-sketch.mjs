// Reveal the original hand-drawn artwork; the skeleton is only an animated mask.
// Usage: node scripts/build-startup-sketch.mjs [input.png] [output.svg]
//        node scripts/build-startup-sketch.mjs --self-test
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const WIDTH = 588;
const HEIGHT = 1130;
const THRESHOLD = 55;
const MASK_WIDTH = 4.4;
const MIN_PATH_LENGTH = 4;
const DRAW_DURATION = 2.4;
const DIRECTIONS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

function foregroundCount(pixels) {
  let count = 0;
  for (const value of pixels) count += value;
  return count;
}

// Two simultaneous deletion passes preserve endpoints and connectivity. Padding
// keeps strokes touching the source image boundary eligible for thinning too.
export function thinZhangSuen(source, width, height) {
  const stride = width + 2;
  const pixels = new Uint8Array(stride * (height + 2));
  for (let y = 0; y < height; y++) pixels.set(source.subarray(y * width, (y + 1) * width), (y + 1) * stride + 1);
  const offsets = [-stride, -stride + 1, 1, stride + 1, stride, stride - 1, -1, -stride - 1];
  let changed = true;
  let iterations = 0;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const remove = [];
      for (let y = 1; y <= height; y++) for (let x = 1; x <= width; x++) {
        const i = y * stride + x;
        if (!pixels[i]) continue;
        const p = offsets.map(offset => pixels[i + offset]);
        const neighbours = p.reduce((sum, value) => sum + value, 0);
        if (neighbours < 2 || neighbours > 6) continue;
        let transitions = 0;
        for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) transitions++;
        if (transitions !== 1) continue;
        if (pass === 0 ? p[0] * p[2] * p[4] || p[2] * p[4] * p[6] : p[0] * p[2] * p[6] || p[0] * p[4] * p[6]) continue;
        remove.push(i);
      }
      for (const i of remove) pixels[i] = 0;
      if (remove.length) changed = true;
    }
    iterations++;
    assert(iterations <= Math.max(width, height), "Skeleton thinning did not converge.");
  }
  const skeleton = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) skeleton.set(pixels.subarray((y + 1) * stride + 1, (y + 1) * stride + width + 1), y * width);
  return { skeleton, iterations };
}

function makeGraph(pixels, width, height) {
  const links = new Uint8Array(pixels.length);
  const degrees = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    if (!pixels[i]) continue;
    const x = i % width;
    const y = Math.floor(i / width);
    for (let d = 0; d < 8; d++) {
      const [dx, dy] = DIRECTIONS[d];
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height || !pixels[ny * width + nx]) continue;
      // Do not turn a one-pixel staircase into overlapping triangular edges.
      if (dx && dy && (pixels[y * width + nx] || pixels[ny * width + x])) continue;
      links[i] |= 1 << d;
      degrees[i]++;
    }
  }
  return { links, degrees };
}

export function traceSkeleton(pixels, width, height, minimumLength = MIN_PATH_LENGTH) {
  const { links, degrees } = makeGraph(pixels, width, height);
  const visited = new Uint8Array(pixels.length);
  const paths = [];
  let tracedEdges = 0;
  let discardedPaths = 0;
  const neighbour = (i, d) => i + DIRECTIONS[d][0] + DIRECTIONS[d][1] * width;
  const walk = (start, direction) => {
    const points = [[start % width, Math.floor(start / width)]];
    let current = start;
    let d = direction;
    let length = 0;
    for (;;) {
      const next = neighbour(current, d);
      visited[current] |= 1 << d;
      visited[next] |= 1 << ((d + 4) % 8);
      tracedEdges++;
      length += d % 2 ? Math.SQRT2 : 1;
      points.push([next % width, Math.floor(next / width)]);
      if (degrees[next] !== 2 || next === start) break;
      const available = links[next] & ~visited[next];
      if (!available) break;
      current = next;
      d = 0;
      while (!(available & (1 << d))) d++;
    }
    if (length >= minimumLength) paths.push({ points, length });
    else discardedPaths++;
  };
  // Preserve every branch at intersections, including short eyelash branches.
  for (let i = 0; i < pixels.length; i++) {
    if (degrees[i] === 2) continue;
    for (let d = 0; d < 8; d++) if (links[i] & (1 << d) && !(visited[i] & (1 << d))) walk(i, d);
  }
  // Closed loops have no endpoint; trace their remaining edges separately.
  for (let i = 0; i < pixels.length; i++) for (let d = 0; d < 8; d++) {
    if (links[i] & (1 << d) && !(visited[i] & (1 << d))) walk(i, d);
  }
  const totalEdges = degrees.reduce((sum, degree) => sum + degree, 0) / 2;
  assert.equal(tracedEdges, totalEdges, "Not all skeleton edges were traced.");
  return { paths, tracedEdges, discardedPaths };
}

function simplify(points, tolerance = 0.6) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    const [ax, ay] = points[start];
    const [bx, by] = points[end];
    const dx = bx - ax;
    const dy = by - ay;
    const denominator = dx * dx + dy * dy;
    let greatest = tolerance * tolerance;
    let selected = -1;
    for (let k = start + 1; k < end; k++) {
      const [px, py] = points[k];
      const t = denominator ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denominator)) : 0;
      const distance = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      if (distance > greatest) { greatest = distance; selected = k; }
    }
    if (selected >= 0) { keep[selected] = 1; stack.push([start, selected], [selected, end]); }
  }
  return points.filter((_, index) => keep[index]);
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pathLength = points => points.slice(1).reduce((sum, p, i) => sum + distance(points[i], p), 0);

// A raster crossing splits into several skeleton edges. Pair the edges that
// continue in the same direction so a lock of hair stays one pen movement.
// Branches are not discarded: an unpaired branch remains a separate stroke.
export function joinContinuousStrokes(paths) {
  const strokes = paths.map(p => ({ points: p.points.map(p => [...p]), length: p.length }));
  const ends = new Map();
  const connections = new Map();
  const tangent = (stroke, end) => {
    const points = end ? [...stroke.points].reverse() : stroke.points;
    const a = points[0];
    const b = points.find(p => distance(a, p) >= 7) || points.at(-1);
    const magnitude = distance(a, b) || 1;
    return [(b[0] - a[0]) / magnitude, (b[1] - a[1]) / magnitude];
  };
  for (let i = 0; i < strokes.length; i++) for (let end = 0; end < 2; end++) {
    const key = strokes[i].points[end ? strokes[i].points.length - 1 : 0].join(",");
    if (!ends.has(key)) ends.set(key, []);
    ends.get(key).push({ i, end, vector: tangent(strokes[i], end) });
  }
  for (const candidates of ends.values()) {
    const pairs = [];
    for (let a = 0; a < candidates.length; a++) for (let b = a + 1; b < candidates.length; b++) {
      const one = candidates[a];
      const two = candidates[b];
      if (one.i === two.i) continue;
      const straightness = -one.vector[0] * two.vector[0] - one.vector[1] * two.vector[1];
      if (straightness >= 0.32) pairs.push({ one, two, straightness });
    }
    pairs.sort((a, b) => b.straightness - a.straightness);
    for (const { one, two } of pairs) {
      const a = `${one.i}:${one.end}`;
      const b = `${two.i}:${two.end}`;
      if (connections.has(a) || connections.has(b)) continue;
      connections.set(a, two);
      connections.set(b, one);
    }
  }
  const visited = new Set();
  const combined = [];
  const walk = (index, firstEnd) => {
    const points = [];
    let i = index;
    let end = firstEnd;
    while (!visited.has(i)) {
      visited.add(i);
      const segment = end ? [...strokes[i].points].reverse() : strokes[i].points;
      points.push(...(points.length ? segment.slice(1) : segment));
      const next = connections.get(`${i}:${1 - end}`);
      if (!next) break;
      i = next.i;
      end = next.end;
    }
    combined.push({ points, length: pathLength(points) });
  };
  for (let i = 0; i < strokes.length; i++) {
    if (visited.has(i)) continue;
    if (!connections.has(`${i}:0`)) walk(i, 0);
    else if (!connections.has(`${i}:1`)) walk(i, 1);
  }
  for (let i = 0; i < strokes.length; i++) if (!visited.has(i)) walk(i, 0);
  // Antialiasing and the small highlight gaps in hand-drawn strokes can leave
  // two ends a few pixels apart. Reconnect only tangent-aligned ends; a pen
  // crosses the tiny gap without ever revealing unrelated neighbouring lines.
  let current = combined;
  for (let pass = 0; pass < 3; pass++) {
    const cell = 8;
    const grid = new Map();
    const candidates = [];
    for (let i = 0; i < current.length; i++) for (let end = 0; end < 2; end++) {
      const point = current[i].points[end ? current[i].points.length - 1 : 0];
      const vector = tangent(current[i], end);
      const gx = Math.floor(point[0] / cell);
      const gy = Math.floor(point[1] / cell);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        for (const other of grid.get(`${gx + dx}:${gy + dy}`) || []) {
          if (other.i === i) continue;
          const gap = distance(point, other.point);
          if (gap < 0.2 || gap > 6) continue;
          const dot = vector[0] * other.vector[0] + vector[1] * other.vector[1];
          const vx = (other.point[0] - point[0]) / gap;
          const vy = (other.point[1] - point[1]) / gap;
          if (dot > -0.5 || vx * vector[0] + vy * vector[1] > -0.35 || vx * other.vector[0] + vy * other.vector[1] < 0.35) continue;
          candidates.push({ a: { i, end }, b: other, score: gap + (1 + dot) * 5 });
        }
      }
      const key = `${gx}:${gy}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push({ i, end, point, vector });
    }
    const joins = new Map();
    for (const { a, b } of candidates.sort((a, b) => a.score - b.score)) {
      const ak = `${a.i}:${a.end}`;
      const bk = `${b.i}:${b.end}`;
      if (joins.has(ak) || joins.has(bk)) continue;
      joins.set(ak, b);
      joins.set(bk, a);
    }
    if (!joins.size) break;
    const used = new Set();
    const nextStrokes = [];
    const follow = (index, entry) => {
      const points = [];
      let i = index;
      let end = entry;
      while (!used.has(i)) {
        used.add(i);
        const segment = end ? [...current[i].points].reverse() : current[i].points;
        points.push(...segment);
        const next = joins.get(`${i}:${1 - end}`);
        if (!next) break;
        i = next.i;
        end = next.end;
      }
      nextStrokes.push({ points, length: pathLength(points) });
    };
    for (let i = 0; i < current.length; i++) {
      if (used.has(i)) continue;
      if (!joins.has(`${i}:0`)) follow(i, 0);
      else if (!joins.has(`${i}:1`)) follow(i, 1);
    }
    for (let i = 0; i < current.length; i++) if (!used.has(i)) follow(i, 0);
    current = nextStrokes;
  }
  return current;
}

function prepareStrokes(paths) {
  // Separate face/hair and costume strength without deleting the shoulders,
  // sleeves, arms, or bodice silhouette.
  const split = [];
  for (const stroke of joinContinuousStrokes(paths)) {
    let points = [];
    for (const point of stroke.points) {
      if (points.length > 1 && (point[1] < 515) !== (points.at(-1)[1] < 515)) {
        points.push(point);
        split.push({ points, length: pathLength(points) });
        points = [point];
      } else points.push(point);
    }
    if (points.length > 1) split.push({ points, length: pathLength(points) });
  }
  return split.map(({ points, length }) => {
    const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
    const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
    // The left shoulder rises beside the face; a horizontal crop would remove
    // that sleeve even though it is part of the basic costume silhouette.
    const shoulder = cx < 168 && cy > 335;
    return { points: simplify(points, 0.48), length, cx, cy, head: cy < 515 && !shoulder };
  });
}

// Endpoints in the skeleton are discovered in raster order. Keep that traversal
// order from making every pen travel downwards: use a stable spatial hash to
// choose the starting end of each stroke independently. Closed loops also begin
// at different positions, rather than all beginning at their topmost pixel.
function orientStroke(stroke, index) {
  if (!stroke.points) return stroke;
  let points = [...stroke.points];
  const first = points[0];
  const last = points.at(-1);
  const hash = ((Math.round(stroke.cx * 17) * 73856093) ^ (Math.round(stroke.cy * 19) * 19349663) ^ (index * 83492791)) >>> 0;
  if (distance(first, last) < 1 && points.length > 5) {
    const ring = points.slice(0, -1);
    const offset = hash % ring.length;
    points = [...ring.slice(offset), ...ring.slice(0, offset)];
    points.push(points[0]);
  }
  if (hash & 1) points.reverse();
  return { ...stroke, points };
}

export function schedulePaths(paths) {
  const prepared = prepareStrokes(paths);
  const headCandidates = prepared.filter(p => p.head && p.length >= 22 && p.cx > 155);
  const head = headCandidates.sort((a, b) => b.length - a.length).slice(0, 150);
  for (const stroke of prepared) {
    if (stroke.head && stroke.cx > 280 && stroke.cx < 350 && stroke.cy > 370 && stroke.cy < 425 && !head.includes(stroke)) head.push(stroke);
  }
  // Keep long costume contours and shorter marks on the outer sleeves/cape.
  // Omit small interior folds and ornament instead of cutting off the body.
  const body = prepared.filter(p => {
    if (p.head || p.length < 28) return false;
    // The detached butterfly beside the shoulder is not a costume contour.
    if (p.cx < 95 && p.cy < 440) return false;
    if (p.length >= 78) return true;
    return p.points.some(([x, y]) =>
      (x < 150 && y > 335) || (x > 515 && y > 500) ||
      (y > 850 && (x < 165 || x > 425)));
  });
  // Every pen starts together and travels continuously to its own endpoint.
  // Different physical lengths therefore have different drawing speeds, but
  // they all reach completion together, as in the reference animation.
  const result = [
    ...head.map(p => ({ ...p, width: MASK_WIDTH, strength: 1 })),
    ...body.map(p => ({ ...p, width: MASK_WIDTH + 0.4, strength: 0.76 })),
  ].map(orientStroke);
  // A sideways pen pass reveals the little serrated lashes in the original
  // artwork. These stay as painted detail, rather than a synthetic eye line.
  result.push({ d: "M217 303Q248 327 290 326", length: 80, width: 18, strength: 1, head: true });
  result.push({ d: "M453 359Q400 371 354 345", length: 104, width: 19, strength: 1, head: true });
  return result.map(stroke => ({ ...stroke, delay: 0, duration: DRAW_DURATION }));
}

export async function buildStartupSketch(input, output) {
  const png = await sharp(input).rotate().resize(WIDTH, HEIGHT, { fit: "fill" }).flatten({ background: "#000000" }).png().toBuffer();
  const gray = await sharp(png).greyscale().raw().toBuffer();
  const foreground = Uint8Array.from(gray, value => Number(value > THRESHOLD));
  const foregroundPixels = foregroundCount(foreground);
  assert(foregroundPixels >= 8, `No visible drawing above brightness ${THRESHOLD} in ${input}.`);
  const { skeleton, iterations } = thinZhangSuen(foreground, WIDTH, HEIGHT);
  const { paths, tracedEdges, discardedPaths } = traceSkeleton(skeleton, WIDTH, HEIGHT, 1);
  assert(paths.length, "No drawing paths of at least 4px were found.");
  const strokes = schedulePaths(paths);
  const growingPaths = [];
  for (const stroke of strokes) {
    const { points, length, delay, duration, width, strength } = stroke;
    assert(length >= MIN_PATH_LENGTH && delay === 0 && duration === DRAW_DURATION);
    const d = stroke.d || `M${points[0].join(" ")}${points.slice(1).map(p => `L${p.join(" ")}`).join("")}`;
    growingPaths.push(`<path class="grow ${stroke.head ? "head" : "costume"}" d="${d}" pathLength="1" stroke-width="${width}" opacity="${strength}" style="--delay:${delay}s;--duration:${duration}s"/>`);
  }
  const pathElements = growingPaths.join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<title>Magic Box simultaneous hand-drawn startup portrait</title>
<style>
.stroke{fill:none;stroke:#fff;stroke-linecap:round;stroke-linejoin:round}
.stroke .grow{stroke-dasharray:1 1;stroke-dashoffset:1;animation:draw var(--duration) var(--delay) linear both}
@keyframes draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){.stroke path{animation:none;stroke-dashoffset:0}}
</style>
<defs><mask id="hand-drawn-reveal" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" style="mask-type:luminance">
<rect width="${WIDTH}" height="${HEIGHT}" fill="#000"/>
<g class="stroke">${pathElements}</g>
</mask></defs>
<rect width="${WIDTH}" height="${HEIGHT}" fill="#000"/>
<image width="${WIDTH}" height="${HEIGHT}" preserveAspectRatio="none" href="data:image/png;base64,${png.toString("base64")}" mask="url(#hand-drawn-reveal)"/>
</svg>\n`;
  assert(svg.includes(`viewBox="0 0 ${WIDTH} ${HEIGHT}"`));
  assert.equal((svg.match(/<image\b/g) || []).length, 1);
  assert(!/href="(?!data:image\/png;base64,)/.test(svg), "The SVG must not depend on an external raster image.");
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(output, svg);
  return { input, output, width: WIDTH, height: HEIGHT, threshold: THRESHOLD, maskWidth: MASK_WIDTH, foregroundPixels, skeletonPixels: foregroundCount(skeleton), thinningIterations: iterations, skeletonFragments: paths.length, strokes: strokes.length, headStrokes: strokes.filter(p => p.head).length, costumeStrokes: strokes.filter(p => !p.head).length, renderedPaths: growingPaths.length, longestDuration: Math.max(...strokes.map(p => p.duration)), tracedEdges, discardedPaths, firstStrokeAt: Math.min(...strokes.map(stroke => stroke.delay)), completeAt: Math.max(...strokes.map(p => p.delay + p.duration)), bytes: Buffer.byteLength(svg) };
}

async function selfTest() {
  const fixture = new Uint8Array(16 * 16);
  // A 4px diagonal lash is retained, and a closed loop is traced without loss.
  for (let k = 1; k <= 5; k++) fixture[k * 16 + k] = 1;
  for (let k = 8; k <= 13; k++) { fixture[8 * 16 + k] = 1; fixture[13 * 16 + k] = 1; fixture[k * 16 + 8] = 1; fixture[k * 16 + 13] = 1; }
  const trace = traceSkeleton(fixture, 16, 16);
  assert.equal(trace.paths.length, 2);
  assert(trace.paths.some(stroke => stroke.length > 4 && stroke.length < 6));
  assert(trace.paths.some(stroke => stroke.points[0].join() === stroke.points.at(-1).join()));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-sketch-test-"));
  try {
    const input = path.join(directory, "sketch.png");
    const output = path.join(directory, "sketch.svg");
    const artwork = `<svg xmlns="http://www.w3.org/2000/svg" width="588" height="1130"><rect width="588" height="1130" fill="black"/><g fill="none" stroke="#8fe5ff" stroke-linecap="round"><path d="M80 100Q360 5 500 300Q540 540 360 850" stroke-width="7"/><path d="M130 350Q220 405 320 355M150 362l-8 11M173 372l-5 14M200 379l-2 12M230 379l3 11M260 372l7 10" stroke-width="4"/><circle cx="400" cy="600" r="38" stroke-width="5"/></g></svg>`;
    await sharp(Buffer.from(artwork)).png().toFile(input);
    const report = await buildStartupSketch(input, output);
    assert(report.skeletonPixels < report.foregroundPixels / 2, "Thinning did not reduce thick strokes to a skeleton.");
    assert(report.headStrokes >= 3, "Continuous head strokes were lost.");
    assert(report.costumeStrokes >= 1, "The body silhouette must remain visible.");
    assert.equal(report.firstStrokeAt, 0);
    assert.equal(report.completeAt, DRAW_DURATION);
    const svg = await fs.readFile(output, "utf8");
    const embedded = svg.match(/href="data:image\/png;base64,([^"]+)"/)[1];
    const metadata = await sharp(Buffer.from(embedded, "base64")).metadata();
    assert.equal(metadata.width, WIDTH);
    assert.equal(metadata.height, HEIGHT);
    assert(!svg.includes('class="complete"'), "A completion wipe must never reveal the portrait.");
    assert(!svg.includes("@keyframes complete"), "Drawing must not use opacity fades.");
    const timings = [...svg.matchAll(/style="--delay:([\d.]+)s;--duration:([\d.]+)s"/g)];
    assert(timings.length >= 3);
    assert(timings.every(([, start, duration]) => Number(start) === 0 && Number(duration) === DRAW_DURATION), "Every stroke must begin and finish together.");
    assert(/class="grow costume"[^>]+opacity="0\.76"/.test(svg), "Costume outlines need readable strength instead of a near-invisible trace.");
    const scheduled = schedulePaths([
      { points: [[210, 40], [211, 200], [215, 330]], length: 290 },
      { points: [[300, 60], [320, 210], [330, 350]], length: 295 },
      { points: [[370, 75], [365, 210], [370, 370]], length: 295 },
      { points: [[430, 100], [415, 240], [440, 380]], length: 295 },
    ]).filter(p => p.points);
    const verticalDirections = new Set(scheduled.map(p => Math.sign(p.points.at(-1)[1] - p.points[0][1])));
    assert(verticalDirections.has(-1) && verticalDirections.has(1), "Pen directions must vary instead of all travelling downwards.");
    console.log(JSON.stringify({ selfTest: "passed", ...report, input: "temporary synthetic hand-drawn fixture", output: "temporary SVG (cleaned up)" }));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes("--self-test")) await selfTest();
  else {
    const input = process.argv[2] || "public/assets/magic-box-startup-sketch.png";
    const output = process.argv[3] || "public/assets/magic-box-startup-lines-v5.svg";
    console.log(JSON.stringify(await buildStartupSketch(input, output)));
  }
}

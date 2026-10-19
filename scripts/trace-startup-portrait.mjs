// Convert the existing portrait's structural edges into actual drawable SVG paths.
// No filtered raster is displayed by the opening sequence.
import sharp from "sharp";
import fs from "node:fs/promises";
const input = process.argv[2] || "public/assets/magic-box-girl.jpg";
const output = process.argv[3] || "public/assets/magic-box-startup-lines.svg";
const { data, info: { width: w, height: h } } = await sharp(input).resize(588, 1130, { fit: "fill" }).greyscale().blur(1.05).raw().toBuffer({ resolveWithObject: true });
const n = w * h, magnitude = new Float32Array(n), direction = new Uint8Array(n);
for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
  const i = y * w + x;
  const gx = -data[i-w-1] + data[i-w+1] - 2*data[i-1] + 2*data[i+1] - data[i+w-1] + data[i+w+1];
  const gy = -data[i-w-1] - 2*data[i-w] - data[i-w+1] + data[i+w-1] + 2*data[i+w] + data[i+w+1];
  magnitude[i] = Math.hypot(gx, gy);
  const angle = (Math.atan2(gy, gx) * 180 / Math.PI + 180) % 180;
  direction[i] = angle < 22.5 || angle >= 157.5 ? 0 : angle < 67.5 ? 1 : angle < 112.5 ? 2 : 3;
}
const edges = new Uint8Array(n), offsets = [1, w+1, w, w-1], queue = [];
for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
  // Open irises are excluded; closed eyelash paths are drawn separately.
  if ((x > 210 && x < 306 && y > 280 && y < 360) || (x > 346 && x < 454 && y > 319 && y < 393)) continue;
  const i = y*w+x, v = magnitude[i], offset = offsets[direction[i]];
  if (v < 14 || v < magnitude[i-offset] || v < magnitude[i+offset]) continue;
  edges[i] = v >= 31 ? 2 : 1;
  if (edges[i] === 2) queue.push(i);
}
const neighbours = [-w-1,-w,-w+1,-1,1,w-1,w,w+1];
for (let k=0;k<queue.length;k++) for (const d of neighbours) {
  const next=queue[k]+d;
  if (edges[next]===1) {edges[next]=2;queue.push(next);}
}
const visited = new Uint8Array(n), paths=[];
function follow(start) {
  const chain=[start]; visited[start]=1;
  let current=start, previous=-1;
  for (;;) {
    const options=neighbours.map(d=>current+d).filter(i=>edges[i]===2&&!visited[i]);
    if(!options.length) break;
    if(previous>=0) {
      const dx=current%w-previous%w, dy=(current/w|0)-(previous/w|0);
      options.sort((a,b)=> {
        const score=i=>(dx*(i%w-current%w)+dy*((i/w|0)-(current/w|0)))/Math.hypot(i%w-current%w,(i/w|0)-(current/w|0));
        return score(b)-score(a);
      });
    }
    previous=current;current=options[0];visited[current]=1;chain.push(current);
  }
  return chain;
}
function simplify(points,epsilon=.7) {
  if(points.length<=2)return points;
  const a=points[0],b=points.at(-1),dx=b[0]-a[0],dy=b[1]-a[1],den=Math.hypot(dx,dy)||1;
  let max=0,index=0;
  for(let i=1;i<points.length-1;i++) {
    const distance=Math.abs(dy*points[i][0]-dx*points[i][1]+b[0]*a[1]-b[1]*a[0])/den;
    if(distance>max){max=distance;index=i;}
  }
  return max>epsilon?[...simplify(points.slice(0,index+1),epsilon).slice(0,-1),...simplify(points.slice(index),epsilon)]:[a,b];
}
function trace(start) {
  if(visited[start]||edges[start]!==2)return;
  const chain=follow(start);
  // Follow the other side of an initial point too, retaining continuous strokes.
  const other=neighbours.map(d=>start+d).find(i=>edges[i]===2&&!visited[i]);
  if(other!==undefined)chain.unshift(...follow(other).reverse());
  if(chain.length<18)return;
  const pts=simplify(chain.map(i=>[i%w,i/w|0]));
  let length=0;for(let i=1;i<pts.length;i++)length+=Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]);
  if(length<21)return;
  let d=`M${pts[0].join(" ")}`;
  for(let i=1;i<pts.length-1;i++) d+=`Q${pts[i].join(" ")} ${((pts[i][0]+pts[i+1][0])/2).toFixed(1)} ${((pts[i][1]+pts[i+1][1])/2).toFixed(1)}`;
  d+=`L${pts.at(-1).join(" ")}`;
  const cy=chain.reduce((sum,i)=>sum+(i/w|0),0)/chain.length;
  paths.push({d,length:Math.round(length),cy});
}
for(const i of queue)if(neighbours.reduce((count,d)=>count+(edges[i+d]===2),0)===1)trace(i);
for(const i of queue)trace(i);
paths.sort((a,b)=>b.length-a.length);
const strokes=paths.map(({d,length,cy},i)=>({d,delay:Number((.04+((i*73)%590)/1000).toFixed(3)),duration:Number((.36+Math.min(length,350)/850).toFixed(3)),opacity:cy>650?.44:.8}));
// Deliberate, continuous closed eyelash strokes are essential to the awakening.
strokes.push({d:"M219 311 Q248 338 288 327 M220 310l-7-4 M226 317l-8-2 M233 322l-7 0",delay:.19,duration:.86,opacity:1});
strokes.push({d:"M358 349 Q399 376 442 359 M436 362l9-2 M429 365l10 1 M421 367l8 3",delay:.26,duration:.86,opacity:1});
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 588 1130" fill="none" stroke="#9bdfea" stroke-width=".78" stroke-linecap="round" stroke-linejoin="round">
<style>path{stroke-dasharray:1;stroke-dashoffset:1;animation:ink var(--duration) var(--delay) cubic-bezier(.2,.65,.25,1) both}@keyframes ink{to{stroke-dashoffset:0}}</style>
${strokes.map(({d,delay,duration,opacity})=>`<path d="${d}" pathLength="1" opacity="${opacity}" style="--delay:${delay}s;--duration:${duration}s"/>`).join("\n")}
</svg>\n`;
await fs.writeFile(output, svg);
console.log(JSON.stringify({strokes:strokes.length,output,bytes:Buffer.byteLength(svg)}));

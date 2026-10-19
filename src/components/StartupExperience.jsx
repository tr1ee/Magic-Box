import { useCallback, useEffect, useRef, useState } from "react";
import "./startup-experience.css";

const PORTRAIT = "/assets/magic-box-girl.jpg";
const INK_PORTRAIT = "/assets/magic-box-startup-lines-v5.svg";
const EYE_FILM = "/assets/magic-box-eye-opening-v6.mp4";
const EYE_POSTER = "/assets/magic-box-eye-opening-v6.webp";
const MOTES = Array.from({ length: 28 }, (_, i) => ({
  left: `${(i * 37 + 9) % 100}%`, top: `${(i * 23 + 7) % 100}%`,
  delay: `${-(i % 7)}s`, size: `${i % 3 + 1}px`
}));

function Butterfly({ variant }) {
  return (
    <div className={`startup-butterfly startup-butterfly-${variant}`}>
      <svg viewBox="0 0 120 90" fill="none">
        {["left", "right"].map(side => (
          <g key={side} className={`startup-wing-${side}`}>
            <g transform={side === "right" ? "translate(120 0) scale(-1 1)" : undefined}>
              <path className="startup-wing-fill" d="M60 49C45 10 12 0 9 12c-4 17 19 37 48 40C32 42 20 54 27 68c9 13 23-1 33-19Z" />
              <path className="startup-wing-panel" d="M53 44C41 23 24 10 16 14c-1 10 15 24 37 30Zm1 9C39 48 29 56 32 63c6 5 15-3 22-10Z" />
              <path className="startup-wing-vein" d="M55 47 17 17m37 29C43 26 29 15 18 14M53 46C35 34 23 26 16 17M55 52 33 63m21-10-17 2" />
              <g className="startup-wing-spots"><ellipse cx="13" cy="13" rx="1.7" ry="2.6" /><ellipse cx="17" cy="23" rx="1.5" ry="2.4" transform="rotate(-28 17 23)" /><ellipse cx="24" cy="32" rx="1.4" ry="2.5" transform="rotate(-40 24 32)" /><ellipse cx="28" cy="61" rx="1.2" ry="2" /><ellipse cx="33" cy="67" rx="2" ry="1" /></g>
            </g>
          </g>
        ))}
        <path className="startup-butterfly-body" d="m60 32 1 28m-1-24-7-12m7 12 7-12" strokeWidth="1.5" />
      </svg>
    </div>
  );
}

// State belongs to this document's lifetime, so restoring the native window
// doesn't replay the sequence. The app boots under the overlay in parallel.
export default function StartupExperience({ children }) {
  const [visible, setVisible] = useState(true);
  const [leaving, setLeaving] = useState(false);
  const [portraitReady, setPortraitReady] = useState(false);
  const [filmReady, setFilmReady] = useState(false);
  const [phase, setPhase] = useState("drawing");
  const [reducedMotion, setReducedMotion] = useState(() =>
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
  const ready = portraitReady && (reducedMotion || filmReady);
  const eyeFilmRef = useRef(null);
  const skipRef = useRef(null);
  const contentRef = useRef(null);

  const leave = useCallback(() => setLeaving(true), []);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    media?.addEventListener("change", update);
    return () => media?.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    // Slow or missing artwork must never keep the user outside the toolbox.
    if (!visible) return;
    const safetyTimer = window.setTimeout(leave, 12000);
    skipRef.current?.focus({ preventScroll: true });
    const onKey = (event) => {
      if (event.key === "Escape") { event.preventDefault(); leave(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(safetyTimer);
      window.removeEventListener("keydown", onKey);
    };
  }, [leave, visible]);

  useEffect(() => {
    if (!visible || !ready) return;
    const timer = window.setTimeout(leave, reducedMotion ? 900 : 8700);
    return () => window.clearTimeout(timer);
  }, [leave, ready, reducedMotion, visible]);

  useEffect(() => {
    if (!ready || !visible || reducedMotion) return;
    // Transfer color underneath the completed strokes before the eye film begins.
    const stages = [[2450, "hold"], [3000, "impact"], [3100, "awakening"], [4700, "welcome"]];
    const timers = stages.map(([time, name]) => window.setTimeout(() => setPhase(name), time));
    return () => timers.forEach(window.clearTimeout);
  }, [ready, reducedMotion, visible]);

  useEffect(() => {
    if (!ready || !visible || leaving || reducedMotion) return;
    const film = eyeFilmRef.current;
    const timer = window.setTimeout(() => {
      if (!film) return;
      film.currentTime = 0;
      film.play()?.catch(leave);
    }, 3350);
    return () => {
      window.clearTimeout(timer);
      film?.pause();
    };
  }, [leave, leaving, ready, reducedMotion, visible]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setVisible(false), reducedMotion ? 80 : 650);
    return () => window.clearTimeout(timer);
  }, [leaving, reducedMotion]);

  useEffect(() => {
    if (!visible) contentRef.current?.focus({ preventScroll: true });
  }, [visible]);

  return (
    <>
      <div ref={contentRef} className="startup-app-content" inert={visible} aria-hidden={visible || undefined} tabIndex={-1}>
        {children}
      </div>
      {visible ? (
        <section
          className={`startup-screen${ready ? " is-ready" : ""}${leaving ? " is-leaving" : ""}${reducedMotion ? " is-reduced" : ""}`}
          aria-label="Magic Box 启动动画" aria-busy={!ready}
          data-phase={reducedMotion ? "reduced" : phase}
        >
          <div className="startup-art" aria-hidden="true">
            <div className="startup-ambient" />
            <div className="startup-depth-scene">
              <div className="startup-depth-backdrop"><img src={PORTRAIT} alt="" /></div>
              <div className="startup-portrait">
                <div className="startup-painted">
                  <img className="startup-color" src={PORTRAIT} alt="" fetchPriority="high" onLoad={() => setPortraitReady(true)} onError={leave} />
                  <video ref={eyeFilmRef} className="startup-eye-film" src={EYE_FILM} poster={EYE_POSTER}
                    muted playsInline disablePictureInPicture preload={reducedMotion ? "none" : "auto"}
                    onLoadedData={() => setFilmReady(true)} onError={leave} />
                </div>
                {ready ? <img className="startup-contours" src={INK_PORTRAIT} alt="" onError={leave} /> : null}
              </div>
            </div>
            <div className="startup-shade" />
            <div className="startup-orbit" />
            <div className="startup-motes">
              {MOTES.map((mote, i) => <i key={i} style={{ left: mote.left, top: mote.top, "--delay": mote.delay, "--size": mote.size }} />)}
            </div>
            <Butterfly variant="near" />
            <Butterfly variant="far" />
          </div>
          <header className="startup-brand">
            <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
              <path d="m24 3 19 11v21L24 46 5 35V14L24 3Zm0 0v21m19-10L24 24 5 14m19 10v22M5 35l19-11 19 11" stroke="currentColor" strokeWidth="1" />
              <path d="m24 11 11 7v12l-11 7-11-7V18l11-7Z" stroke="currentColor" />
            </svg>
            <div><span>MAGIC BOX</span><small>让灵感，在此苏醒</small></div>
          </header>
          <div className="startup-copy">
            <p className="startup-eyebrow">A LITTLE WONDER. EVERY DAY.</p>
            <h1>Magic Box<span>.</span></h1>
            <div className="startup-rule" />
            <p className="startup-welcome">欢迎回来，创造者。</p>
            <p className="startup-caption">YOUR IDEAS, UNBOXED.</p>
          </div>
          <footer className="startup-footer">
            <span>LOCAL TOOLS. LIMITLESS POSSIBILITIES.</span>
            <button ref={skipRef} type="button" onClick={leave}>跳过并进入 <kbd>ESC</kbd></button>
          </footer>
          <div className="startup-timeline" aria-hidden="true"><span /></div>
        </section>
      ) : null}
    </>
  );
}

# Startup motion assets

The four new eye inbetweens were produced with the built-in Image Gen tool. Only painted eye regions are composited over the unchanged original portrait at runtime; no extra eyelid lines are drawn.

## Saved production assets

- `public/assets/magic-box-eye-slit-v4.webp`: 10% eye aperture.
- `public/assets/magic-box-eye-mid-v4.webp`: 40% eye aperture.
- `public/assets/magic-box-eye-three-quarter-v4.webp`: 75% eye aperture.
- `public/assets/magic-box-eye-almost-v4.webp`: 90% eye aperture.

These and the existing closed, quarter, half, and fully open portraits are source poses for the continuous V6 film described below. They are no longer crossfaded as runtime SVG layers.

## Prompt set

Input 1 (edit target): `public/assets/magic-box-girl-closed.png`.
Input 2 (half-open reference): `public/assets/magic-box-girl-half.png`.
Input 3 (fully open reference): `public/assets/magic-box-girl.jpg`.

Shared prompt: “Use case: precise-object-edit. Asset type: one single full portrait animation inbetween frame, locked composition. Change ONLY the eyes of image 1 to the specified aperture. Keep both eyes at the same relative aperture, naturally easing open with painted eyelashes. The upper eyelash is curved organic dark burgundy with delicate lashes; no straight black stroke, extra outline, or doubled eyelid. Identity, head angle, camera crop, hair, eyebrows, nose, mouth, face proportions, butterflies, clothing, lighting, colors and every non-eye pixel remain unchanged. Eye corners and positions stay fixed. Match the original anime illustration and pink irises. One frame, original aspect ratio, no reframing, text, grid, or split panel.”

Aperture variants:

- Slit: almost closed, only a very thin curved sliver of pink iris beneath the upper eyelashes, 10% of full height.
- Mid: 40% open, between the closed and half-open references, with the upper lid smoothly lifted.
- Three-quarter: 75% open, close to the original but with upper lids still slightly lowered.
- Almost: 90% open, extremely close to the original fully open portrait, with upper lids marginally lower.

## V6 continuous eye film

Four additional key poses (20%, 50%, 68%, 82%) were generated with built-in Image Gen, saved as `public/assets/magic-box-eye-{twenty,fifty,sixtyeight,eightytwo}-v6.webp`. Exact generation prompts and sources are recorded in [startup-v6-generation-prompts.json](startup-v6-generation-prompts.json).

`node scripts/build-startup-eye-film.mjs` color-calibrates all twelve key poses, composites through one common eye region exactly once onto the original portrait, and motion-interpolates the eye area. Production files are `public/assets/magic-box-eye-opening-v6.mp4` and the matching `.webp` poster. The twelve key poses are sorted by measured eye aperture rather than nominal generation prompts, with time allocated to avoid a fast final jump. The film contains 96 frames at 60 fps over 1.6 seconds; the app starts it at 3.35 seconds. Runtime uses one complete portrait video, with no overlapping elliptical eye layers. Portrait scale stays constant during the existing lateral parallax.

The ink and color now exchange continuously over 3020–3200 ms, with no brightness, saturation, or blur pulse.

## Drawing and depth

`node scripts/build-startup-sketch.mjs` builds the standalone V5 SVG. All 413 strokes begin at 0 seconds and finish at 2.4 seconds; dash offsets continuously extend each stroke from its own selected endpoint. Directions vary. Hair and face retain fine detail, while shoulder, sleeve, arm, collar, torso and waist outlines remain readable. Only smaller interior folds are omitted. There are no grouped opacity fades or full-frame completion reveals.

`public/assets/magic-box-subject-mask-v5.svg` and `magic-box-backdrop-mask-v5.svg` separate the unchanged original portrait into foreground and background using vector silhouettes. The foreground and all eye overlays translate together from center to left, then right; the background shifts oppositely at a smaller amplitude. Foreground width, height and Z remain constant throughout. Neither the impact transition nor subsequent portrait motion includes scaling. Reduced motion uses the original static composition.

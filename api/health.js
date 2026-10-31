import { LIMITS, providers } from './_shared.js';

export default function handler(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ mode: 'hosted', providers: providers(), passcode_required: Boolean(process.env.LIVE_PASSCODE),
    limits: { max_steps: LIMITS.maxSteps, max_pixels: LIMITS.maxPixels } });
}

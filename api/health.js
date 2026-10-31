export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ configured: Boolean(process.env.FAL_KEY), model: 'fal-ai/flux/dev' });
}

// Sends transactional email through Brevo's API. Sending is best effort: it never throws, so an email problem can
// never break a payment, an order or an answer. Nothing is sent without BREVO_API_KEY, and nothing is sent while the
// test suite runs (unless a test points BREVO_API_BASE at its own fake server).
const base = () => process.env.BREVO_API_BASE || 'https://api.brevo.com';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
const adminEmails = () => list(process.env.ADMIN_EMAIL);
const siteUrl = () => (process.env.SITE_URL || 'https://thugilcreation.com').replace(/\/+$/, '');

function disabled() {
  if (!process.env.BREVO_API_KEY) return 'BREVO_API_KEY is not set';
  if (process.env.MAIL_DISABLED === '1') return 'MAIL_DISABLED=1';
  if (process.env.NODE_TEST_CONTEXT && !process.env.BREVO_API_BASE) return 'running tests';
  return null;
}

const FONT = "'Jost','Helvetica Neue',Helvetica,Arial,sans-serif";
const C = { page: '#FBF4EA', panel: '#F1E6D7', soft: '#F7EFE4', band: '#EBD7B3', ink: '#1F1411', muted: '#6A5A56', maroon: '#751423', mark: '#F2DDA8' };

/**
 * The look of every email, in the style of an editorial welcome email (no images):
 * a thin link band, a small greeting, a big two-line title, a pill button, a numbered list of details
 * and a second panel for what happens next.
 *   topLink  { label, url }            the band at the very top
 *   eyebrow  'GREETINGS, ASHA!'        small capitals above the title
 *   title    ['Payment', 'confirmed']  line 1 dark, line 2 maroon
 *   intro    html                      the paragraph under the title
 *   button   { label, url }            the round-ended button
 *   detailsTitle, rows [[label, value]] numbered details
 *   nextTitle ['plain words ', 'highlighted words'], nextPoints []
 *   note     html                      small print
 */
function layout({ topLink, eyebrow, title, intro, button, detailsTitle, rows = [], nextTitle, nextPoints = [], note }) {
  const [l1, l2] = Array.isArray(title) ? title : [title, ''];
  const caps = (t) => `<div style="font-family:${FONT};font-size:12px;letter-spacing:2px;font-weight:600;color:${C.ink};text-transform:uppercase">${esc(t)}</div>`;
  const num = (n) => `<span style="display:inline-block;width:18px;height:18px;line-height:18px;border-radius:9px;background:#DCCBB8;color:${C.ink};font-size:10px;font-weight:700;text-align:center;margin-right:12px;vertical-align:middle">${n}</span>`;
  const detailRows = rows.map(([k, v], i) => `<tr><td style="padding:7px 0;font-family:${FONT};font-size:15px;line-height:1.5;color:${C.ink}">${num(i + 1)}${k ? `<span style="color:${C.muted}">${esc(k)}:</span> ` : ''}<strong style="font-weight:600">${esc(v)}</strong></td></tr>`).join('');
  const nextRows = nextPoints.map((t) => `<tr><td style="padding:6px 0;font-family:${FONT};font-size:15px;line-height:1.5;color:${C.ink}"><span style="color:${C.muted};margin-right:8px">&middot;</span>${esc(t)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link href="https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600;700&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:${C.page}">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${C.page}"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;max-width:600px">
${topLink ? `<tr><td align="center" style="background:${C.band};padding:11px 16px"><a href="${esc(topLink.url)}" style="font-family:${FONT};font-size:14px;font-weight:600;color:${C.ink};text-decoration:none">${esc(topLink.label)} &nbsp;&rarr;</a></td></tr>` : ''}
<tr><td style="background:${C.panel};padding:40px 32px 36px">
${eyebrow ? `<div style="margin-bottom:14px">${caps(eyebrow)}</div>` : ''}
<div style="font-family:${FONT};font-size:44px;line-height:1.08;font-weight:500;color:${C.ink};letter-spacing:-0.5px">${esc(l1)}${l2 ? `<br><span style="color:${C.maroon}">${esc(l2)}</span>` : ''}</div>
${intro ? `<p style="margin:22px 0 0;font-family:${FONT};font-size:16px;line-height:1.65;color:${C.ink}">${intro}</p>` : ''}
${button ? `<table cellpadding="0" cellspacing="0" role="presentation" style="margin-top:28px"><tr><td style="background:${C.maroon};border-radius:30px;padding:0 0 0 26px"><a href="${esc(button.url)}" style="display:inline-block;font-family:${FONT};font-size:15px;font-weight:600;color:#FEF9F3;text-decoration:none;padding:16px 14px 16px 0;vertical-align:middle">${esc(button.label)}</a><span style="display:inline-block;width:38px;height:38px;line-height:38px;margin:5px 5px 5px 8px;border-radius:19px;background:#FEF9F3;color:${C.maroon};text-align:center;font-size:18px;font-weight:700;vertical-align:middle">&rarr;</span></td></tr></table>` : ''}
${rows.length ? `<div style="margin:34px 0 8px">${caps(detailsTitle || 'Details:')}</div><table width="100%" cellpadding="0" cellspacing="0" role="presentation">${detailRows}</table>` : ''}
</td></tr>
${nextPoints.length ? `<tr><td style="background:${C.soft};padding:34px 32px"><div style="font-family:${FONT};font-size:28px;line-height:1.3;font-weight:500;color:${C.ink};margin-bottom:14px">${esc((nextTitle || ['What happens next:', ''])[0])}${(nextTitle || [])[1] ? `<span style="background:${C.mark}">${esc(nextTitle[1])}</span>` : ''}</div><table width="100%" cellpadding="0" cellspacing="0" role="presentation">${nextRows}</table>${note ? `<p style="margin:20px 0 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${C.muted}">${note}</p>` : ''}</td></tr>` : (note ? `<tr><td style="background:${C.soft};padding:24px 32px;font-family:${FONT};font-size:13px;line-height:1.6;color:${C.muted}">${note}</td></tr>` : '')}
<tr><td style="padding:22px 32px 30px;font-family:${FONT};font-size:12px;line-height:1.6;color:#A09089;text-align:center">Thugil Creation &middot; Kondalampatty, Salem, Tamil Nadu<br>thugilcreation@gmail.com &middot; +91 8838008499</td></tr>
</table></td></tr></table></body></html>`;
}

/**
 * @param {{ to: string|string[]|{email:string,name?:string}[], subject: string, html: string, text?: string, tags?: string[] }} mail
 * @returns {Promise<boolean>} true when Brevo accepted it
 */
async function sendMail({ to, subject, html, text, tags }) {
  const recipients = (Array.isArray(to) ? to : [to])
    .map((t) => (typeof t === 'string' ? { email: t.trim() } : { email: String(t?.email || '').trim(), ...(t?.name ? { name: t.name } : {}) }))
    .filter((t) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t.email));
  if (!recipients.length) return false;
  const off = disabled();
  if (off) { console.log(`[mail] not sent (${off}): "${subject}" -> ${recipients.map((r) => r.email).join(', ')}`); return false; }
  const from = process.env.MAIL_FROM_EMAIL;
  if (!from) { console.error('[mail] MAIL_FROM_EMAIL is not set'); return false; }
  try {
    const res = await fetch(`${base()}/v3/smtp/email`, {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: process.env.MAIL_FROM_NAME || 'Thugil Creation', email: from },
        to: recipients, subject, htmlContent: html, ...(text ? { textContent: text } : {}), ...(tags ? { tags } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) { console.error(`[mail] Brevo refused "${subject}" (${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`); return false; }
    return true;
  } catch (err) {
    console.error(`[mail] could not send "${subject}": ${err.message}`);
    return false;
  }
}

module.exports = { sendMail, layout, esc, adminEmails, siteUrl };

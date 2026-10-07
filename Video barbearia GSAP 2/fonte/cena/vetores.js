// Mascote DOKI barbeiro e logo, 100% vetoriais (SVG), com partes articuladas para o GSAP.
const MASCOTE_SVG = `
<svg viewBox="0 0 400 640" width="100%" height="100%" overflow="visible">
  <defs>
    <linearGradient id="mbBody" x1="0" x2="1"><stop offset="0" stop-color="#05080c"/><stop offset=".35" stop-color="#1c2633"/><stop offset=".6" stop-color="#111a24"/><stop offset="1" stop-color="#030508"/></linearGradient>
    <radialGradient id="mbFace" cx=".45" cy=".35" r=".8"><stop offset="0" stop-color="#ffffff"/><stop offset=".7" stop-color="#e9eef3"/><stop offset="1" stop-color="#bcc6d0"/></radialGradient>
    <linearGradient id="mbBeak" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb35c"/><stop offset="1" stop-color="#e46a1f"/></linearGradient>
    <linearGradient id="mbFoot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffab55"/><stop offset="1" stop-color="#d9601a"/></linearGradient>
    <linearGradient id="mbBand" x1="0" x2="1"><stop offset="0" stop-color="#2a8fa6"/><stop offset=".5" stop-color="#7fe3ee"/><stop offset="1" stop-color="#2a8fa6"/></linearGradient>
    <linearGradient id="mbCup" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3a4d5e"/><stop offset="1" stop-color="#0f1922"/></linearGradient>
    <linearGradient id="mbVisor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2c3a48"/><stop offset="1" stop-color="#0c131b"/></linearGradient>
    <linearGradient id="mbD" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00DDF2"/><stop offset="1" stop-color="#078BFF"/></linearGradient>
    <linearGradient id="mbApron" x1="0" x2="1"><stop offset="0" stop-color="#05070a"/><stop offset=".45" stop-color="#151b23"/><stop offset="1" stop-color="#040608"/></linearGradient>
    <linearGradient id="mbChrome" x1="0" x2="1"><stop offset="0" stop-color="#7f8b96"/><stop offset=".4" stop-color="#f2f6f9"/><stop offset="1" stop-color="#6a7580"/></linearGradient>
    <clipPath id="mbVisorClip"><path d="M88 158 Q200 134 312 158 L304 214 Q272 236 222 222 Q200 215 178 222 Q128 236 96 214 Z"/></clipPath>
  </defs>
  <g class="pes">
    <ellipse cx="148" cy="606" rx="50" ry="19" fill="url(#mbFoot)"/><ellipse cx="252" cy="606" rx="50" ry="19" fill="url(#mbFoot)"/>
  </g>
  <g class="corpo">
    <path d="M200 40 C 300 40 332 150 337 285 C 344 430 322 585 200 598 C 78 585 56 430 63 285 C 68 150 100 40 200 40 Z" fill="url(#mbBody)"/>
    <path d="M200 40 C 300 40 332 150 337 285 C 344 430 322 585 200 598" fill="none" stroke="rgba(0,221,242,.45)" stroke-width="3"/>
    <path d="M200 40 C 100 40 68 150 63 285 C 56 430 78 585 200 598" fill="none" stroke="rgba(120,180,255,.18)" stroke-width="2"/>
    <ellipse cx="200" cy="400" rx="100" ry="150" fill="url(#mbFace)"/>
    <path d="M200 110 C 150 74 92 98 98 176 C 102 236 140 256 158 296 C 172 326 228 326 242 296 C 260 256 298 236 302 176 C 308 98 250 74 200 110 Z" fill="url(#mbFace)"/>
    <!-- avental -->
    <path class="avental" d="M104 318 L296 318 L306 350 C 326 440 322 540 296 580 L104 580 C 78 540 74 440 94 350 Z" fill="url(#mbApron)"/>
    <path d="M120 318 L150 236 M280 318 L250 236" stroke="#0a0e13" stroke-width="12" stroke-linecap="round"/>
    <rect x="118" y="452" width="164" height="92" rx="10" fill="none" stroke="#2a3542" stroke-width="3" stroke-dasharray="7 6"/>
    <g class="bolso" transform="translate(0 26)">
      <rect x="132" y="404" width="12" height="60" rx="3" fill="#2b3440"/><g fill="#2b3440"><rect x="144" y="410" width="10" height="3"/><rect x="144" y="418" width="10" height="3"/><rect x="144" y="426" width="10" height="3"/><rect x="144" y="434" width="10" height="3"/><rect x="144" y="442" width="10" height="3"/></g>
      <path d="M166 458 L176 410 M186 458 L172 410" stroke="url(#mbChrome)" stroke-width="5" stroke-linecap="round"/>
      <circle cx="170" cy="402" r="9" fill="none" stroke="url(#mbChrome)" stroke-width="4"/><circle cx="184" cy="402" r="9" fill="none" stroke="url(#mbChrome)" stroke-width="4"/>
    </g>
    <g class="logoD" transform="translate(203 352)">
      <path d="M-26 -30 H2 C24 -30 36 -14 36 4 C36 22 24 38 2 38 H-12 L-26 50 Z" fill="none" stroke="url(#mbD)" stroke-width="9" stroke-linejoin="round"/>
      <path d="M-2 -12 C10 -12 16 -2 14 10 C12 22 4 28 -6 28 C0 18 2 6 -2 -12 Z" fill="url(#mbD)"/><circle cx="4" cy="-4" r="3" fill="#03111F"/>
    </g>
    <g class="flipL" ><path d="M84 262 C 40 300 30 390 50 445 C 60 466 82 452 88 428 C 100 370 104 312 100 276 Z" fill="url(#mbBody)" stroke="rgba(0,221,242,.35)" stroke-width="3"/></g>
    <g class="flipR"><path d="M316 262 C 360 300 370 390 350 445 C 340 466 318 452 312 428 C 300 370 296 312 300 276 Z" fill="url(#mbBody)" stroke="rgba(0,221,242,.35)" stroke-width="3"/></g>
    <!-- braços cruzados -->
    <g class="cruzados">
      <path d="M70 282 C 120 262 230 286 300 318 C 318 326 314 350 294 352 C 220 352 140 340 86 330 C 60 324 52 292 70 282 Z" fill="url(#mbBody)" stroke="rgba(0,221,242,.3)" stroke-width="2"/>
      <path d="M330 282 C 280 262 170 290 100 326 C 82 334 88 360 108 360 C 182 356 262 336 314 326 C 340 320 348 292 330 282 Z" fill="url(#mbBody)" stroke="rgba(0,221,242,.35)" stroke-width="2"/>
    </g>
    <!-- fones -->
    <path d="M66 206 C 52 50 348 50 334 206" fill="none" stroke="url(#mbBand)" stroke-width="22" stroke-linecap="round"/>
    <path d="M78 196 C 70 70 330 70 322 196" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="4"/>
    <g class="cupL"><rect x="38" y="168" width="52" height="92" rx="24" fill="url(#mbCup)" stroke="#7fe3ee" stroke-width="5"/><circle cx="58" cy="214" r="16" fill="none" stroke="#00DDF2" stroke-width="4"/></g>
    <g class="cupR"><rect x="310" y="168" width="52" height="92" rx="24" fill="url(#mbCup)" stroke="#7fe3ee" stroke-width="5"/><circle cx="342" cy="214" r="16" fill="none" stroke="#00DDF2" stroke-width="4"/><path d="M336 205 h6 a9 9 0 0 1 0 18 h-6 z" fill="none" stroke="#00DDF2" stroke-width="3"/></g>
    <!-- óculos -->
    <path d="M88 158 Q200 134 312 158 L304 214 Q272 236 222 222 Q200 215 178 222 Q128 236 96 214 Z" fill="url(#mbVisor)" stroke="#aebbc7" stroke-width="9" stroke-linejoin="round"/>
    <g clip-path="url(#mbVisorClip)" fill="rgba(255,255,255,.55)">
      <polygon points="130,140 160,140 120,240 90,240"/><polygon points="172,140 186,140 146,240 132,240"/>
      <polygon points="250,140 280,140 240,240 210,240"/><polygon points="292,140 306,140 266,240 252,240"/>
      <rect class="brilhoOculos" x="-120" y="120" width="40" height="140" fill="rgba(255,255,255,.7)" transform="skewX(-25)"/>
    </g>
    <path class="bico" d="M176 226 Q200 214 224 226 Q218 254 200 260 Q182 254 176 226 Z" fill="url(#mbBeak)"/>
  </g>
</svg>`;

function LOGO_SVG(sub) {
  return `<svg viewBox="0 0 520 ${sub ? 330 : 290}" width="100%" overflow="visible">
  <defs><linearGradient id="lgD" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#36E3A1"/><stop offset=".55" stop-color="#00B8E6"/><stop offset="1" stop-color="#078BFF"/></linearGradient></defs>
  <g class="lgIcon" transform="translate(200 4)">
    <path class="lgDpath" d="M14 10 H62 C98 10 118 36 118 68 C118 100 98 126 62 126 H38 L14 146 Z" fill="none" stroke="url(#lgD)" stroke-width="16" stroke-linejoin="round"/>
    <g class="lgPeng"><path d="M58 40 C78 40 88 56 86 76 C84 98 70 110 52 112 C62 96 64 72 58 40 Z" fill="url(#lgD)"/>
    <circle cx="68" cy="58" r="10" fill="#fff"/><circle cx="70" cy="58" r="4.5" fill="#03111F"/><path d="M78 66 L96 72 L78 76 Z" fill="#FFB35C"/></g>
  </g>
  <text class="lgTxt" x="260" y="232" text-anchor="middle" font-family="Inter" font-weight="900" font-size="96" letter-spacing="2" fill="#fff">DOKI</text>
  <text class="lgSub" x="260" y="272" text-anchor="middle" font-family="Inter" font-weight="600" font-size="27" letter-spacing="4" fill="#cfe2f2">CHATS INTELIGENTES</text>
  ${sub ? '<text class="lgSub2" x="260" y="310" text-anchor="middle" font-family="Inter" font-weight="600" font-size="17" letter-spacing="3" fill="#9DB4C8">MANAUS &amp; COREIA · A CONEXÃO GELADA DO NORTE</text>' : ''}
</svg>`;
}

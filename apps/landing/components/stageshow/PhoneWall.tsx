'use client'

// The closing picture: real screens from Phone Use runs on iOSWorld, one per
// app, drifting in three rows on a plane tipped away from the reader. Many of
// one (references/framing.md): one thing at one size, off every edge, no words
// on any of it. The captures carry their own status bar and island, so the
// kit's phone draws neither.

import { Phone } from './kit/phone'
import './phone-wall.css'

const APPS = [
  'caltrack-001', 'cinephile-001', 'cityride-001', 'clock-001', 'clouddocs-004', 'clouddrive-001', 'cloudsheets-003', 'cloudslides-002',
  'dinespot-001', 'freshcart-001', 'lockedin-001', 'mail-002', 'megamart-001', 'mybank-003', 'notes-001', 'quickbite-001',
  'quickchat-003', 'scorezone-003', 'skytrip-002', 'splitpay-001', 'stayfinder-001', 'tasterank-001', 'teamchat-003', 'weather-004',
] as const

// Interleave so neighbours differ in colour and kind across rows
const ROWS = [0, 1, 2].map((r) => APPS.filter((_, i) => i % 3 === r))

export default function PhoneWall() {
  return (
    <div className="pw" aria-hidden>
      <div className="pw-plane">
        {ROWS.map((row, r) => (
          <div key={r} className="pw-row" data-dir={r % 2 ? 'right' : 'left'}>
            <div className="pw-track">
              {[...row, ...row].map((app, i) => (
                <Phone key={`${app}-${i}`} width={168} frame="pro" island={false} status={false} wallpaper={`#fff url(/bench/${app}.jpg) center top / cover no-repeat`} className="pw-phone" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

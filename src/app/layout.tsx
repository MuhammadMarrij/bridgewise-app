import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'BridgeWise — your money across borders',
  description: 'Compare what real banks and transfer providers would charge you today for a tuition payment, against your deadline and your living costs.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        {children}
      </body>
    </html>
  );
}

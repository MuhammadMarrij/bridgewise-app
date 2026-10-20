import { NextResponse } from 'next/server';

// Minimal liveness. Deliberately exposes no configuration, versions or secrets.
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({
    status: 'ok',
    mode: process.env.EXECUTION_MODE === 'SIMULATED' ? 'SIMULATED' : 'UNCONFIGURED',
  });
}

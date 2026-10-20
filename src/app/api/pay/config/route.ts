import { json } from '@/lib/api/http';
import { providerConfig } from '@/lib/connectors/live';

export const dynamic = 'force-dynamic';

/** Which real providers are switched on. Publishes only the Stripe publishable key. */
export async function GET() {
  return json(providerConfig());
}

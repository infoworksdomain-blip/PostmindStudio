import { hardNavigate } from '@/lib/client/navigate';

// Where the browser goes next after Checkout or the Customer Portal answers { url }. Its own module
// so tests can replace it (jsdom does not navigate).
export function navigateTo(url: string): void {
  hardNavigate(url);
}

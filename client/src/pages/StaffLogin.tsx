import Login from './Login';

/**
 * Staff login surface for /staff/login.
 *
 * The audience is fixed by the route, and enforcement stays server-side: the gateway posts to
 * the staff-only Rust endpoint, which rejects non-staff credentials with the generic message.
 * This screen is intentionally not linked from any public page.
 */
export default function StaffLogin() {
    return <Login audience="staff" />;
}

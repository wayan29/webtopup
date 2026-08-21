import { Suspense, useEffect, useState, type ReactElement } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import AuthLayout from './layouts/AuthLayout';
import DashboardLayout from './layouts/DashboardLayout';
import { Home, Login, StaffLogin, Register, Leaderboard, Articles, Products, Order, CheckTransaction } from './pages/PublicRoutes';
import { STAFF_LOGIN_PATH, loginPathWithReturnTo } from './auth/loginIntent';
import { captureGuestAuthEntry, guestRouteShouldRedirect, type GuestAuthEntry } from './auth/guestAuthIntent';
import { isPublicAppPath } from './auth/publicRouteIntent';
import { DashboardIndex, DashboardHistory, DashboardMutation, DashboardReport } from './pages/dashboard/DashboardRoutes';
import { Deposit, RedeemVoucher, Transactions, Mutations, Reports, Settings, Account, Credits } from './pages/MemberRoutes';
import AdminLayout from './layouts/AdminLayout';
import {
  AdminDashboard,
  AdminDeposits,
  AdminProducts,
  AdminCatalogAudit,
  AdminProductCategories,
  AdminProductOperators,
  AdminProductOperatorForm,
  AdminProductTypes,
  AdminProductTypeForm,
  AdminPaymentCategories,
  AdminPaymentMethods,
  AdminSliders,
  AdminAddOns,
  AdminSiteConfig,
  AdminTransactions,
  AdminManualTransactions,
  AdminUsers,
  AdminVouchers,
  AdminSalesReport,
  AdminPromoReport,
  AdminVendors,
  AdminVendorHealth,
  AdminRewards,
  AdminTeams,
  AdminDigiflazzSettings,
  AdminDigiflazzSellerCenter,
  AdminTokovoucherSettings,
  AdminMargins,
  AdminValidation,
  AdminGuestTransactions,
  AdminFlashSales,
  AdminAuditLogs,
  AdminNotifications,
  AdminProfile
} from './pages/admin/AdminRoutes';
import { disposeAuthStoreRuntime, initAuthStoreRuntime, useAuthStore } from './store/useAuthStore';
import { getAuthCoordinator } from './auth/sessionRuntime.ts';
import {
  bootstrapScreenAllowsRetry,
  lockedSessionMayRequireOtp,
  resolveAppBootstrapScreen,
  shouldHoldProtectedRoute,
  shouldRefreshOnVisibility,
} from './auth/authIntent';
import {
  createEnrollmentDeadlineTimer,
  isEnrollmentOverdue,
  parseAuthoritativeTimestamp,
} from './auth/twoFactorEnrollmentClock.ts';
import SessionStateScreen from './components/auth/SessionStateScreen';
import IdleLockScreen from './components/auth/IdleLockScreen';
import SessionManagement from './pages/SessionManagement';
import {
  getAdminRoutePermission,
  getPreferredAdminLandingPath,
  type AdminPermissionKey
} from './lib/adminNav';

function AuthLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 text-gray-600">
      <div className="flex flex-col items-center gap-2">
        <div className="h-10 w-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
        <p className="text-sm font-medium">Memuat sesi...</p>
      </div>
    </div>
  );
}

function ProtectedRoute({ children }: { children: ReactElement }) {
  const auth = useAuthStore();
  const location = useLocation();
  const { isAuthenticated, isTeamMember } = auth;

  if (shouldHoldProtectedRoute(auth)) {
    return <AuthLoading />;
  }

  if (!isAuthenticated) {
    // Preserve the attempted destination so an interrupted deep link survives login.
    return <Navigate to={loginPathWithReturnTo('member', `${location.pathname}${location.search}${location.hash}`)} replace />;
  }

  if (isTeamMember) {
    return <Navigate to="/admin/dashboard" replace />;
  }

  return children;
}

function GuestAuthRoute({ children }: { children: ReactElement }) {
  const { isAuthenticated, isTeamMember, isAuthLoading } = useAuthStore();
  const [entry, setEntry] = useState<GuestAuthEntry>('pending');
  const capturedEntry = captureGuestAuthEntry(entry, isAuthLoading, isAuthenticated);

  // Persist the first settled classification without making effect ordering responsible for
  // navigation. The render already uses the pure transition result; this update only preserves
  // it for a later authentication transition on the same route mount.
  if (capturedEntry !== entry) setEntry(capturedEntry);

  if (capturedEntry === 'pending') {
    return <AuthLoading />;
  }

  if (guestRouteShouldRedirect(capturedEntry, isAuthenticated)) {
    return <Navigate to={isTeamMember ? '/admin/dashboard' : '/dashboard'} replace />;
  }

  return children;
}

function AdminRoute({ children }: { children: ReactElement }) {
  const auth = useAuthStore();
  const location = useLocation();
  const { isAuthenticated, isTeamMember, user, serverTimeOffsetMs } = auth;
  // Tick forces a re-render at the exact enrollment deadline for long-lived pages.
  const [, setDeadlineTick] = useState(0);

  useEffect(() => {
    if (!user || user.twoFactorEnabled || !isTeamMember) return;
    const deadlineMs = parseAuthoritativeTimestamp(user.twoFactorEnrollmentRequiredAt);
    if (deadlineMs === null || serverTimeOffsetMs === null) return;

    const controller = createEnrollmentDeadlineTimer({
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id),
      onTick: () => setDeadlineTick((value) => value + 1),
    });
    // Exact-boundary gate: schedule once to the deadline (controller uses minute cadence
    // when remaining is large, but still fires at the exact final remaining delay).
    controller.start({
      deadlineMs,
      serverTimeOffsetMs,
    });
    return () => {
      controller.stop();
    };
  }, [
    user?.id,
    user?.twoFactorEnabled,
    user?.twoFactorEnrollmentRequiredAt,
    serverTimeOffsetMs,
    isTeamMember,
  ]);

  if (shouldHoldProtectedRoute(auth)) {
    return <AuthLoading />;
  }

  if (!isAuthenticated) {
    // Admin surfaces belong to the staff channel; the member form cannot mint a staff session.
    return <Navigate to={loginPathWithReturnTo('staff', `${location.pathname}${location.search}${location.hash}`)} replace />;
  }

  if (!isTeamMember) {
    return <Navigate to="/dashboard" replace />;
  }

  // Server enforcement remains authority; client gate is UX-only using memory offset.
  const enrollmentOverdue = isEnrollmentOverdue({
    user,
    clientNowMs: Date.now(),
    serverTimeOffsetMs,
  });
  // /admin/profile hosts the 2FA panel, so it is the enrollment destination. The allowed
  // path and the redirect target must stay the same value: if they diverge, the gate keeps
  // bouncing an overdue staff member and locks them out of the panel entirely.
  if (enrollmentOverdue && window.location.pathname !== '/admin/profile') {
    return <Navigate to="/admin/profile" replace />;
  }

  return children;
}

function getDeniedAdminRedirectPath(hasPermission: (permission: AdminPermissionKey) => boolean, isOwner: boolean) {
  return getPreferredAdminLandingPath((permission) => {
    if (isOwner) return true;
    if (!permission) return true;
    return hasPermission(permission);
  });
}

function AdminPermissionRoute({
  children,
  permission,
  path
}: {
  children: ReactElement;
  /** Optional explicit override; prefer `path` so App.tsx and adminNav stay aligned. */
  permission?: AdminPermissionKey;
  /** Admin path used to resolve permission from ADMIN_ROUTE_PERMISSIONS. */
  path?: string;
}) {
  const auth = useAuthStore();
  const location = useLocation();
  const { isAuthenticated, isTeamMember, isOwner, hasPermission } = auth;

  if (shouldHoldProtectedRoute(auth)) {
    return <AuthLoading />;
  }

  if (!isAuthenticated) {
    return <Navigate to={loginPathWithReturnTo('staff', `${location.pathname}${location.search}${location.hash}`)} replace />;
  }

  if (!isTeamMember) {
    return <Navigate to="/dashboard" replace />;
  }

  const declaredRule = path ? getAdminRoutePermission(path) : undefined;
  const actualRule = getAdminRoutePermission(location.pathname);
  const rulesAgree = Boolean(
    declaredRule
    && actualRule
    && declaredRule.id === actualRule.id
  );
  const requiredPermission = permission ?? actualRule?.permission;
  const teamMemberOnly = Boolean(actualRule?.teamMemberOnly);

  // Client routing is UX-only, but it must still fail closed for unknown or mismatched metadata.
  if (!rulesAgree || (permission && permission !== actualRule?.permission)) {
    return <Navigate to={getDeniedAdminRedirectPath(hasPermission, isOwner)} replace />;
  }

  if (!isOwner && !teamMemberOnly && (!requiredPermission || !hasPermission(requiredPermission))) {
    return <Navigate to={getDeniedAdminRedirectPath(hasPermission, isOwner)} replace />;
  }

  return children;
}

function AdminGuarded({
  path,
  children,
  permission
}: {
  path: string;
  children: ReactElement;
  permission?: AdminPermissionKey;
}) {
  return (
    <AdminPermissionRoute path={path} permission={permission}>
      {children}
    </AdminPermissionRoute>
  );
}

function App() {
  const checkAuth = useAuthStore((state) => state.checkAuth);
  const authPhase = useAuthStore((state) => state.authPhase);
  const authToken = useAuthStore((state) => state.token);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const offlineReturnTo = useAuthStore((state) => state.offlineReturnTo);
  const authFailureMessage = useAuthStore((state) => state.authFailureMessage);
  const retryBootstrap = useAuthStore((state) => state.retryBootstrap);
  const unlockIdleSession = useAuthStore((state) => state.unlockIdleSession);
  const lockedUser = useAuthStore((state) => state.user);

  useEffect(() => {
    initAuthStoreRuntime();
    void checkAuth();
    return () => disposeAuthStoreRuntime();
  }, [checkAuth]);

  useEffect(() => {
    const retry = () => {
      const coordinator = getAuthCoordinator();
      if (!coordinator) return;
      // Guests have no session to refresh; refreshing anyway strands the login page on the
      // blocking "Memuat sesi..." screen after the tab returns from an authenticator app.
      if (!shouldRefreshOnVisibility(useAuthStore.getState())) return;
      void coordinator.refreshOnce('visibility-or-online').catch(() => undefined);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') retry();
    };
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // A locked session recovers only through this form. AdminLayout renders its own copy, but a
  // bootstrap that fails with 423 can land on any route (the reported case targeted "/", which
  // MainLayout serves), so the form has to exist above the router as well.
  if (authPhase === 'locked') {
    return (
      <IdleLockScreen
        phase="locked"
        requiresOtp={lockedSessionMayRequireOtp(lockedUser?.twoFactorEnabled)}
        error={authFailureMessage}
        onUnlock={unlockIdleSession}
      />
    );
  }

  const bootstrapScreen = resolveAppBootstrapScreen(authPhase);
  const publicAnonymousRateLimit = authPhase === 'rate-limited'
    && !authToken
    && !isAuthenticated
    && isPublicAppPath(window.location.pathname);
  if (bootstrapScreen && !publicAnonymousRateLimit) {
    return (
      <SessionStateScreen
        variant={bootstrapScreen}
        returnTo={offlineReturnTo}
        detailMessage={bootstrapScreen === 'bootstrap-retry' || bootstrapScreen === 'rate-limited' ? authFailureMessage : null}
        onRetry={bootstrapScreenAllowsRetry(bootstrapScreen) ? () => { void retryBootstrap(); } : undefined}
      />
    );
  }

  return (
    <Router>
      <Suspense fallback={<AuthLoading />}>
      <Routes>
        {/* Public Routes */}
        <Route path="/" element={<MainLayout />}>
          <Route index element={<Home />} />
          <Route path="products" element={<Products />} />
          <Route path="order/:operator/:type" element={<Order />} />
          <Route path="order/:operator" element={<Order />} />
          <Route path="order" element={<Order />} />
          <Route path="check-transaction" element={<CheckTransaction />} />
          <Route path="leaderboard" element={<Leaderboard />} />
          <Route path="articles" element={<Articles />} />
          <Route path="articles/:slug" element={<Articles />} />

          {/* Protected Routes */}
          <Route path="deposit" element={
            <ProtectedRoute>
              <Navigate to="/dashboard/deposit" replace />
            </ProtectedRoute>
          } />
          <Route path="redeem-voucher" element={
            <ProtectedRoute>
              <RedeemVoucher />
            </ProtectedRoute>
          } />
          <Route path="credits" element={
            <ProtectedRoute>
              <Credits />
            </ProtectedRoute>
          } />
          <Route path="transactions" element={
            <ProtectedRoute>
              <Transactions />
            </ProtectedRoute>
          } />
          <Route path="mutations" element={
            <ProtectedRoute>
              <Mutations />
            </ProtectedRoute>
          } />
          <Route path="reports" element={
            <ProtectedRoute>
              <Reports />
            </ProtectedRoute>
          } />
          <Route path="settings" element={
            <ProtectedRoute>
              <Settings />
            </ProtectedRoute>
          } />
          <Route path="account" element={
            <ProtectedRoute>
              <Account />
            </ProtectedRoute>
          } />
          <Route path="security/sessions" element={<ProtectedRoute><SessionManagement /></ProtectedRoute>} />
        </Route>

        {/* Dashboard Routes */}
        <Route path="/dashboard" element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }>
          <Route index element={<DashboardIndex />} />
          <Route path="history" element={<DashboardHistory />} />
          <Route path="mutation" element={<DashboardMutation />} />
          <Route path="report" element={<DashboardReport />} />
          <Route path="deposit" element={<Deposit />} />
          <Route path="check-transaction" element={<CheckTransaction />} />
        </Route>

        {/* Auth Routes */}
        <Route element={<AuthLayout />}>
          <Route path="/login" element={
            <GuestAuthRoute>
              <Login />
            </GuestAuthRoute>
          } />
          <Route path={STAFF_LOGIN_PATH} element={
            <GuestAuthRoute>
              <StaffLogin />
            </GuestAuthRoute>
          } />
          <Route path="/register" element={
            <GuestAuthRoute>
              <Register />
            </GuestAuthRoute>
          } />
        </Route>

        {/* Admin Routes */}
        <Route path="/admin" element={
          <AdminRoute>
            <AdminLayout />
          </AdminRoute>
        }>
          <Route index element={
            <AdminGuarded path="/admin">
              <AdminDashboard />
            </AdminGuarded>
          } />
          <Route path="dashboard" element={
            <AdminGuarded path="/admin/dashboard">
              <AdminDashboard />
            </AdminGuarded>
          } />
          <Route path="sales-report" element={
            <AdminGuarded path="/admin/sales-report">
              <AdminSalesReport />
            </AdminGuarded>
          } />
          <Route path="promo-report" element={
            <AdminGuarded path="/admin/promo-report">
              <AdminPromoReport />
            </AdminGuarded>
          } />
          <Route path="notifications" element={
            <AdminGuarded path="/admin/notifications">
              <AdminNotifications />
            </AdminGuarded>
          } />
          <Route path="vendors" element={
            <AdminGuarded path="/admin/vendors">
              <AdminVendors />
            </AdminGuarded>
          } />
          <Route path="vendor-health" element={
            <AdminGuarded path="/admin/vendor-health">
              <AdminVendorHealth />
            </AdminGuarded>
          } />
          <Route path="rewards" element={
            <AdminGuarded path="/admin/rewards">
              <AdminRewards />
            </AdminGuarded>
          } />
          <Route path="deposits" element={
            <AdminGuarded path="/admin/deposits">
              <AdminDeposits />
            </AdminGuarded>
          } />
          <Route path="products" element={
            <AdminGuarded path="/admin/products">
              <AdminProducts />
            </AdminGuarded>
          } />
          <Route path="catalog-audit" element={
            <AdminGuarded path="/admin/catalog-audit">
              <AdminCatalogAudit />
            </AdminGuarded>
          } />
          <Route path="product-categories" element={
            <AdminGuarded path="/admin/product-categories">
              <AdminProductCategories />
            </AdminGuarded>
          } />
          <Route path="product-operators" element={
            <AdminGuarded path="/admin/product-operators">
              <AdminProductOperators />
            </AdminGuarded>
          } />
          <Route path="product-operators/create" element={
            <AdminGuarded path="/admin/product-operators/create">
              <AdminProductOperatorForm />
            </AdminGuarded>
          } />
          <Route path="product-operators/edit/:id" element={
            <AdminGuarded path="/admin/product-operators/edit/:id">
              <AdminProductOperatorForm />
            </AdminGuarded>
          } />
          <Route path="product-types" element={
            <AdminGuarded path="/admin/product-types">
              <AdminProductTypes />
            </AdminGuarded>
          } />
          <Route path="product-types/create" element={
            <AdminGuarded path="/admin/product-types/create">
              <AdminProductTypeForm />
            </AdminGuarded>
          } />
          <Route path="product-types/edit/:id" element={
            <AdminGuarded path="/admin/product-types/edit/:id">
              <AdminProductTypeForm />
            </AdminGuarded>
          } />
          <Route path="payment-categories" element={
            <AdminGuarded path="/admin/payment-categories">
              <AdminPaymentCategories />
            </AdminGuarded>
          } />
          <Route path="payment-methods" element={
            <AdminGuarded path="/admin/payment-methods">
              <AdminPaymentMethods />
            </AdminGuarded>
          } />
          <Route path="sliders" element={
            <AdminGuarded path="/admin/sliders">
              <AdminSliders />
            </AdminGuarded>
          } />
          <Route path="addons" element={
            <AdminGuarded path="/admin/addons">
              <AdminAddOns />
            </AdminGuarded>
          } />
          <Route path="margins" element={
            <AdminGuarded path="/admin/margins">
              <AdminMargins />
            </AdminGuarded>
          } />
          <Route path="site-config" element={
            <AdminGuarded path="/admin/site-config">
              <AdminSiteConfig />
            </AdminGuarded>
          } />
          <Route path="transactions" element={
            <AdminGuarded path="/admin/transactions">
              <AdminTransactions />
            </AdminGuarded>
          } />
          <Route path="transactions/manual" element={
            <AdminGuarded path="/admin/transactions/manual">
              <AdminManualTransactions />
            </AdminGuarded>
          } />
          <Route path="transactions/guest" element={
            <AdminGuarded path="/admin/transactions/guest">
              <AdminGuestTransactions />
            </AdminGuarded>
          } />
          <Route path="users" element={
            <AdminGuarded path="/admin/users">
              <AdminUsers />
            </AdminGuarded>
          } />
          <Route path="vouchers" element={
            <AdminGuarded path="/admin/vouchers">
              <AdminVouchers />
            </AdminGuarded>
          } />
          <Route path="teams" element={
            <AdminGuarded path="/admin/teams">
              <AdminTeams />
            </AdminGuarded>
          } />
          <Route path="audit-logs" element={
            <AdminGuarded path="/admin/audit-logs">
              <AdminAuditLogs />
            </AdminGuarded>
          } />
          <Route path="security" element={<Navigate to="/admin/profile" replace />} />
          <Route path="profile" element={
            <AdminGuarded path="/admin/profile">
              <AdminProfile />
            </AdminGuarded>
          } />
          <Route path="security/sessions" element={<AdminRoute><SessionManagement /></AdminRoute>} />
          <Route path="addons/digiflazz" element={
            <AdminGuarded path="/admin/addons/digiflazz">
              <AdminDigiflazzSettings />
            </AdminGuarded>
          } />
          <Route path="addons/digiflazz-seller-center" element={
            <AdminGuarded path="/admin/addons/digiflazz-seller-center">
              <AdminDigiflazzSellerCenter />
            </AdminGuarded>
          } />
          <Route path="addons/digiflazz-seller" element={<Navigate replace to="/admin/addons/digiflazz-seller-center?section=overview" />} />
          <Route path="addons/irs-seller" element={<Navigate replace to="/admin/addons/digiflazz-seller-center?section=irs" />} />
          <Route path="addons/tokovoucher" element={
            <AdminGuarded path="/admin/addons/tokovoucher">
              <AdminTokovoucherSettings />
            </AdminGuarded>
          } />
          <Route path="validation" element={
            <AdminGuarded path="/admin/validation">
              <AdminValidation />
            </AdminGuarded>
          } />
          <Route path="flash-sales" element={
            <AdminGuarded path="/admin/flash-sales">
              <AdminFlashSales />
            </AdminGuarded>
          } />
        </Route>
      </Routes>
      </Suspense>
    </Router>
  );
}

export default App;

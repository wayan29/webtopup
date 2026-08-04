import { lazy } from 'react';

export const DashboardIndex = lazy(() => import('./Index'));
export const DashboardHistory = lazy(() => import('./History'));
export const DashboardMutation = lazy(() => import('./Mutation'));
export const DashboardReport = lazy(() => import('./Report'));

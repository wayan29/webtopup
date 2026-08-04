import { lazy } from 'react';

export const Deposit = lazy(() => import('./Deposit'));
export const RedeemVoucher = lazy(() => import('./RedeemVoucher'));
export const Transactions = lazy(() => import('./Transactions'));
export const Mutations = lazy(() => import('./Mutations'));
export const Reports = lazy(() => import('./Reports'));
export const Settings = lazy(() => import('./Settings'));
export const Account = lazy(() => import('./Account'));
export const Credits = lazy(() => import('./Credits'));

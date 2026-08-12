use std::{env, sync::Arc};

use axum::{
    extract::DefaultBodyLimit,
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, Request},
    routing::{delete, get, post, put},
    Router,
};
use opentelemetry::{global, propagation::Extractor};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::Span;
use tracing_opentelemetry::OpenTelemetrySpanExt;

use crate::security::resolve_request_trace_layer_correlation;
use crate::state::AppState;

pub mod articles;
pub mod audit_logs;
pub mod auth;
pub mod content;
pub mod dashboard;
pub mod deposits;
pub mod digiflazz_seller;
pub mod guest_transactions;
pub mod health;
pub mod irs_seller;
pub mod leaderboard;
pub mod margins;
pub mod notifications;
pub mod open_api;
pub mod payment;
pub mod products;
pub mod reports;
pub mod rewards;
pub mod settings;
pub mod system;
pub mod taxonomy;
pub mod teams;
pub mod transactions;
pub mod uploads;
pub mod users;
pub mod validate;
pub(in crate::routes) mod validation_engine;
pub mod validation_products;
pub mod vendors;
pub mod vouchers;
pub mod webhooks;

pub fn app(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health::health))
        .route(
            "/v2/auth/member/login",
            axum::routing::post(auth::member_login),
        )
        .route(
            "/v2/auth/staff/login",
            axum::routing::post(auth::staff_login),
        )
        .route("/v2/auth/register", axum::routing::post(auth::register))
        .route("/v2/auth/refresh", axum::routing::post(auth::refresh))
        .route("/v2/auth/unlock", axum::routing::post(auth::unlock))
        .route("/v2/auth/step-up", axum::routing::post(auth::step_up))
        .route("/v2/auth/logout", axum::routing::post(auth::logout))
        .route(
            "/v2/auth/session/migrate",
            axum::routing::post(auth::migrate_legacy_session),
        )
        .route(
            "/v2/internal/auth/legacy-migration/acknowledge",
            axum::routing::post(auth::acknowledge_legacy_migration),
        )
        .route(
            "/v2/auth/device-selection",
            axum::routing::post(auth::device_selection),
        )
        .route("/v2/auth/me", get(auth::me))
        .route("/v2/auth/2fa/status", get(auth::two_factor_status))
        .route(
            "/v2/auth/2fa/login-verify",
            axum::routing::post(auth::verify_two_factor_login),
        )
        .route(
            "/v2/auth/2fa/setup",
            axum::routing::post(auth::two_factor_setup),
        )
        .route(
            "/v2/auth/2fa/confirm",
            axum::routing::post(auth::two_factor_confirm),
        )
        .route(
            "/v2/auth/2fa/disable",
            axum::routing::post(auth::two_factor_disable),
        )
        .route("/v2/auth/activity", post(auth::activity))
        .route("/v2/auth/activity-status", get(auth::activity_status))
        .route("/v2/auth/sessions", get(auth::list_sessions))
        .route(
            "/v2/auth/sessions/revoke-current",
            post(auth::revoke_current),
        )
        .route("/v2/auth/sessions/revoke-device", post(auth::revoke_device))
        .route("/v2/auth/sessions/revoke-all", post(auth::revoke_all))
        .route(
            "/v2/auth/sessions/revoke",
            axum::routing::post(auth::revoke_sessions),
        )
        .route("/v2/api/key", get(open_api::get_key))
        .route(
            "/v2/api/key/generate",
            axum::routing::post(open_api::generate_key),
        )
        .route(
            "/v2/api/key/revoke",
            axum::routing::delete(open_api::revoke_key),
        )
        .route("/v2/api/profile", get(open_api::profile))
        .route("/v2/api/categories", get(open_api::categories))
        .route("/v2/api/operators", get(open_api::operators))
        .route("/v2/api/product-types", get(open_api::product_types))
        .route("/v2/api/products", get(open_api::products))
        .route("/v2/api/transaction", post(open_api::create_transaction))
        .route("/v2/api/order", post(open_api::create_transaction))
        .route(
            "/v2/api/transaction/check",
            get(open_api::transaction_check),
        )
        .route("/v2/api/transactions", get(open_api::transactions))
        .route(
            "/v2/validate/freefire",
            axum::routing::post(validate::freefire),
        )
        .route(
            "/v2/validate/mobilelegends",
            axum::routing::post(validate::mobilelegends),
        )
        .route(
            "/v2/validate/operator",
            axum::routing::post(validate::operator),
        )
        .route("/v2/ping", get(health::ping))
        .route("/v2/system/status", get(system::system_status))
        .route("/v2/vendors/health", get(vendors::vendor_health))
        .route(
            "/v2/vendors/health/export",
            get(vendors::export_vendor_health_csv),
        )
        .route(
            "/v2/vendors/health-snapshot",
            get(vendors::vendor_health_snapshot),
        )
        .route("/v2/vendors/{id}/stats", get(vendors::vendor_stats))
        .route("/v2/vendors/admin/all", get(vendors::admin_all))
        .route(
            "/v2/vendors",
            get(vendors::admin_all).post(vendors::create_vendor),
        )
        .route(
            "/v2/vendors/{id}",
            get(vendors::admin_detail)
                .put(vendors::update_vendor)
                .delete(vendors::delete_vendor),
        )
        .route(
            "/v2/vendors/{id}/test",
            axum::routing::post(vendors::test_vendor_connection),
        )
        .route(
            "/v2/vendors/{id}/sync",
            axum::routing::post(vendors::sync_vendor_products),
        )
        .route(
            "/v2/vendors/digiflazz/settings",
            get(vendors::digiflazz_settings).post(vendors::save_digiflazz_settings),
        )
        .route(
            "/v2/vendors/digiflazz/balance",
            get(vendors::digiflazz_balance),
        )
        .route(
            "/v2/vendors/digiflazz/pricelist",
            get(vendors::digiflazz_pricelist),
        )
        .route(
            "/v2/vendors/digiflazz/pricelist/fetch",
            axum::routing::post(vendors::fetch_digiflazz_pricelist),
        )
        .route(
            "/v2/vendors/digiflazz/internal-purchases",
            get(vendors::digiflazz_internal_purchases)
                .post(vendors::create_digiflazz_internal_purchase),
        )
        .route(
            "/v2/vendors/tokovoucher/settings",
            get(vendors::tokovoucher_settings).post(vendors::save_tokovoucher_settings),
        )
        .route(
            "/v2/vendors/tokovoucher/balance",
            get(vendors::tokovoucher_balance),
        )
        .route(
            "/v2/vendors/tokovoucher/categories",
            get(vendors::tokovoucher_categories),
        )
        .route(
            "/v2/vendors/tokovoucher/operators",
            get(vendors::tokovoucher_operators),
        )
        .route(
            "/v2/vendors/tokovoucher/jenis",
            get(vendors::tokovoucher_jenis),
        )
        .route(
            "/v2/vendors/tokovoucher/products",
            get(vendors::tokovoucher_products),
        )
        .route(
            "/v2/vendors/tokovoucher/search",
            get(vendors::tokovoucher_search),
        )
        .route(
            "/v2/vendors/tokovoucher/internal-purchases",
            get(vendors::tokovoucher_internal_purchases)
                .post(vendors::create_tokovoucher_internal_purchase),
        )
        .route(
            "/v2/vouchers",
            get(vouchers::admin_list).post(vouchers::create),
        )
        .route("/v2/vouchers/export", get(vouchers::admin_export))
        .route("/v2/vouchers/giveaways", get(vouchers::giveaway_list).post(vouchers::giveaway_execute))
        .route("/v2/vouchers/giveaways/preview", post(vouchers::giveaway_preview))
        .route("/v2/vouchers/giveaways/{id}", get(vouchers::giveaway_detail))
        .route("/v2/vouchers/discount/validate", post(vouchers::validate_discount))
        .route("/v2/vouchers/redeem", post(vouchers::redeem))
        .route("/v2/vouchers/{id}", delete(vouchers::archive))
        .route(
            "/v2/vouchers/{id}/restore",
            axum::routing::patch(vouchers::restore),
        )
        .route("/v2/webhook/{provider}/config", get(webhooks::config))
        .route(
            "/v2/webhook/{provider}/config",
            axum::routing::post(webhooks::save_config),
        )
        .route("/v2/webhook/{provider}/logs", get(webhooks::logs))
        .route(
            "/v2/articles",
            get(articles::public_list).post(articles::create),
        )
        .route(
            "/v2/articles/{slug}",
            get(articles::public_detail)
                .put(articles::update)
                .delete(articles::delete),
        )
        .route("/v2/audit-logs", get(audit_logs::audit_logs))
        .route("/v2/audit-logs/export", get(audit_logs::export_audit_logs))
        .route("/v2/dashboard/ops-snapshot", get(dashboard::ops_snapshot))
        .route(
            "/v2/digiflazz-seller/settings",
            get(digiflazz_seller::settings).post(digiflazz_seller::save_settings),
        )
        .route("/v2/digiflazz-seller/logs", get(digiflazz_seller::logs))
        .route(
            "/v2/digiflazz-seller/prepaid",
            post(digiflazz_seller::prepaid),
        )
        .route(
            "/v2/irs-seller/settings",
            get(irs_seller::settings).post(irs_seller::save_settings),
        )
        .route("/v2/irs-seller/logs", get(irs_seller::logs))
        .route("/v2/irs-seller/prepaid", post(irs_seller::prepaid))
        .route(
            "/v2/irs-seller/mappings",
            get(irs_seller::mappings).post(irs_seller::save_mapping),
        )
        .route(
            "/v2/irs-seller/mappings/{id}",
            delete(irs_seller::delete_mapping),
        )
        .route("/v2/irs-seller/orders/admin", get(irs_seller::admin_orders))
        .route(
            "/v2/digiflazz-seller/mappings",
            get(digiflazz_seller::mappings).post(digiflazz_seller::save_mapping),
        )
        .route(
            "/v2/digiflazz-seller/mappings/{id}",
            delete(digiflazz_seller::delete_mapping),
        )
        .route(
            "/v2/digiflazz-seller/mappings/{id}/sync",
            post(digiflazz_seller::sync_mapping_by_id),
        )
        .route(
            "/v2/digiflazz-seller/mappings/sync",
            post(digiflazz_seller::sync_all_mappings),
        )
        .route("/v2/digiflazz-seller/orders", get(digiflazz_seller::orders))
        .route(
            "/v2/digiflazz-seller/orders/admin",
            get(digiflazz_seller::admin_orders),
        )
        .route(
            "/v2/digiflazz-seller/orders/admin/export",
            get(digiflazz_seller::admin_orders_export),
        )
        .route(
            "/v2/digiflazz-seller/orders/{id}/retry-callback",
            post(digiflazz_seller::retry_callback),
        )
        .route(
            "/v2/digiflazz-seller/orders/retry-callbacks",
            post(digiflazz_seller::retry_pending_callbacks),
        )
        .route(
            "/v2/digiflazz-seller/orders/process-callback-retries",
            post(digiflazz_seller::process_due_callback_retries),
        )
        .route(
            "/v2/sliders/admin/sort-order",
            axum::routing::put(content::sliders_update_sort_order),
        )
        .route(
            "/v2/sliders/admin/create",
            axum::routing::post(content::slider_create),
        )
        .route(
            "/v2/sliders/admin/{id}",
            axum::routing::put(content::slider_update).delete(content::slider_delete),
        )
        .route("/v2/sliders/admin/all", get(content::sliders_admin_all))
        .route(
            "/v2/digiflazz-seller/orders/process-callback-retries/scheduler/config",
            get(digiflazz_seller::scheduler_config),
        )
        .route(
            "/v2/digiflazz-seller/orders/process-callback-retries/scheduler",
            post(digiflazz_seller::process_due_callback_retries_scheduler),
        )
        .route("/v2/sliders", get(content::sliders_public))
        .route("/v2/flash-sales/active", get(content::flash_sales_active))
        .route(
            "/v2/flash-sales/admin/create",
            post(content::flash_sale_create),
        )
        .route(
            "/v2/flash-sales/admin/all",
            get(content::flash_sales_admin_all),
        )
        .route(
            "/v2/flash-sales/admin/{id}/products/{product_id}",
            delete(content::flash_sale_remove_product),
        )
        .route(
            "/v2/flash-sales/admin/{id}/products",
            post(content::flash_sale_add_product),
        )
        .route(
            "/v2/flash-sales/admin/{id}",
            get(content::flash_sale_admin_detail)
                .put(content::flash_sale_update)
                .delete(content::flash_sale_delete),
        )
        .route("/v2/leaderboard", get(leaderboard::get_leaderboard))
        .route(
            "/v2/flash-sales/price/{product_id}",
            get(content::flash_sale_price),
        )
        .route(
            "/v2/deposits/queue-snapshot",
            get(deposits::deposit_queue_snapshot),
        )
        .route(
            "/v2/deposits",
            get(deposits::member_list).post(deposits::request_deposit),
        )
        .route("/v2/deposits/admin/export", get(deposits::admin_export))
        .route("/v2/deposits/admin/all", get(deposits::admin_list))
        .route("/v2/deposits/admin/list", get(deposits::admin_list))
        .route("/v2/deposits/{id}/claim", post(deposits::claim_deposit))
        .route(
            "/v2/deposits/{id}/release-claim",
            post(deposits::release_deposit_claim),
        )
        .route("/v2/deposits/{id}/approve", put(deposits::approve_deposit))
        .route("/v2/deposits/{id}/reject", put(deposits::reject_deposit))
        .route(
            "/v2/notifications/admin/summary",
            get(notifications::admin_summary),
        )
        .route(
            "/v2/notifications/admin/read-all",
            post(notifications::mark_all_read),
        )
        .route(
            "/v2/notifications/admin/{id}/read",
            post(notifications::mark_read),
        )
        .route(
            "/v2/notifications/admin/{id}/dismiss",
            post(notifications::dismiss),
        )
        .route("/v2/notifications/admin", get(notifications::admin_list))
        .route("/v2/reports/dashboard", get(reports::dashboard_overview))
        .route("/v2/reports/sales", get(reports::sales_summary))
        .route("/v2/reports/sales/summary", get(reports::sales_summary))
        .route("/v2/reports/promo", get(reports::promo_summary))
        .route("/v2/reports/promo/export", get(reports::promo_export))
        .route(
            "/v2/reports/sales/export",
            get(reports::export_sales_report),
        )
        .route("/v2/rewards", get(rewards::rewards_public))
        .route("/v2/rewards/{id}", get(rewards::reward_public_detail))
        .route("/v2/rewards/admin/create", post(rewards::reward_create))
        .route(
            "/v2/rewards/admin/{id}",
            axum::routing::put(rewards::reward_update).delete(rewards::reward_delete),
        )
        .route("/v2/rewards/admin/all", get(rewards::rewards_admin_all))
        .route(
            "/v2/points/settings",
            get(rewards::points_settings).put(rewards::points_settings_update),
        )
        .route("/v2/points/stats", get(rewards::points_stats))
        .route("/v2/points/history", get(rewards::points_history))
        .route("/v2/points/adjust", post(rewards::points_adjust))
        .route("/v2/points/transactions", get(rewards::point_transactions))
        .route(
            "/v2/guest-transactions",
            get(guest_transactions::admin_list).post(guest_transactions::create_public),
        )
        .route(
            "/v2/guest-transactions/{id}/cancel",
            post(guest_transactions::cancel_admin),
        )
        .route(
            "/v2/guest-transactions/{id}/confirm",
            post(guest_transactions::confirm_admin),
        )
        .route(
            "/v2/guest-transactions/{id}/status",
            axum::routing::put(guest_transactions::update_status_admin),
        )
        .route(
            "/v2/guest-transactions/check/{invoice_number}",
            get(guest_transactions::check_public),
        )
        .route(
            "/v2/products",
            get(products::public_list).post(products::create_product),
        )
        .route(
            "/v2/products/{id}",
            get(products::public_detail)
                .put(products::update_product)
                .delete(products::delete_product),
        )
        .route("/v2/products/admin/all", get(products::admin_all))
        .route(
            "/v2/validation-products",
            get(validation_products::list).post(validation_products::create),
        )
        .route(
            "/v2/validation-products/{id}",
            axum::routing::put(validation_products::update).delete(validation_products::archive),
        )
        .route(
            "/v2/validation-products/taxonomy/categories",
            get(taxonomy::validation_taxonomy_categories),
        )
        .route(
            "/v2/validation-products/taxonomy/operators",
            get(taxonomy::validation_taxonomy_operators),
        )
        .route(
            "/v2/validation-products/taxonomy/product-types",
            get(taxonomy::validation_taxonomy_product_types),
        )
        .route(
            "/v2/products/admin/sort-order",
            axum::routing::post(products::update_sort_order),
        )
        .route(
            "/v2/products/admin/sort-by-price",
            axum::routing::post(products::sort_by_price),
        )
        .route(
            "/v2/products/admin/catalog-audit",
            get(products::catalog_audit),
        )
        .route("/v2/products/admin/sorting", get(products::admin_sorting))
        .route(
            "/v2/payment-methods",
            get(payment::methods_public).post(payment::method_create),
        )
        .route("/v2/payment-methods/active", get(payment::methods_active))
        .route(
            "/v2/payment-methods/admin/all",
            get(payment::methods_admin_all),
        )
        .route(
            "/v2/payment-methods/{id}",
            axum::routing::put(payment::method_update).delete(payment::method_delete),
        )
        .route(
            "/v2/payment-categories/admin/all",
            get(payment::categories_admin_all),
        )
        .route(
            "/v2/payment-categories/reorder",
            axum::routing::put(payment::categories_reorder),
        )
        .route(
            "/v2/payment-categories/{id}",
            axum::routing::put(payment::category_update).delete(payment::category_delete),
        )
        .route(
            "/v2/payment-categories",
            get(payment::categories_public).post(payment::category_create),
        )
        .route(
            "/v2/payment-categories/active",
            get(payment::categories_active),
        )
        .route(
            "/v2/categories/admin/all",
            get(taxonomy::categories_admin_all),
        )
        .route(
            "/v2/categories/admin/create",
            axum::routing::post(taxonomy::category_admin_create),
        )
        .route(
            "/v2/categories/admin/sort-order",
            axum::routing::put(taxonomy::categories_update_sort_order),
        )
        .route(
            "/v2/categories/admin/{id}",
            axum::routing::put(taxonomy::category_admin_update)
                .delete(taxonomy::category_admin_delete),
        )
        .route("/v2/categories", get(taxonomy::categories_public))
        .route("/v2/categories/{id}", get(taxonomy::category_public_detail))
        .route(
            "/v2/operators/admin/all",
            get(taxonomy::operators_admin_all),
        )
        .route(
            "/v2/operators/admin/create",
            axum::routing::post(taxonomy::operator_admin_create),
        )
        .route(
            "/v2/operators/admin/sort-order",
            axum::routing::put(taxonomy::operators_update_sort_order),
        )
        .route("/v2/operators", get(taxonomy::operators_public))
        .route("/v2/operators/{id}", get(taxonomy::operator_public_detail))
        .route(
            "/v2/operators/admin/{id}",
            get(taxonomy::operator_admin_detail)
                .put(taxonomy::operator_admin_update)
                .delete(taxonomy::operator_admin_delete),
        )
        .route(
            "/v2/product-types/admin/all",
            get(taxonomy::product_types_admin_all),
        )
        .route(
            "/v2/product-types/admin/create",
            axum::routing::post(taxonomy::product_type_admin_create),
        )
        .route(
            "/v2/product-types/admin/sort-order",
            axum::routing::put(taxonomy::product_types_update_sort_order),
        )
        .route("/v2/product-types", get(taxonomy::product_types_public))
        .route(
            "/v2/product-types/{id}",
            get(taxonomy::product_type_public_detail),
        )
        .route(
            "/v2/product-types/admin/{id}",
            get(taxonomy::product_type_admin_detail)
                .put(taxonomy::product_type_admin_update)
                .delete(taxonomy::product_type_admin_delete),
        )
        .route(
            "/v2/transactions/manual",
            get(transactions::manual_transactions),
        )
        .route(
            "/v2/transactions",
            get(transactions::member_transactions).post(transactions::create_transaction),
        )
        .route(
            "/v2/transactions/admin/stuck",
            get(transactions::stuck_transactions),
        )
        .route(
            "/v2/transactions/admin/export",
            get(transactions::admin_transactions_export),
        )
        .route(
            "/v2/transactions/admin",
            get(transactions::admin_transactions),
        )
        .route(
            "/v2/transactions/{id}/refund",
            post(transactions::refund_transaction),
        )
        .route(
            "/v2/transactions/{id}/recheck",
            post(transactions::recheck_status),
        )
        .route(
            "/v2/transactions/{id}/status",
            put(transactions::update_status),
        )
        .route(
            "/v2/transactions/stuck",
            get(transactions::stuck_transactions),
        )
        .route("/v2/settings/public", get(settings::public_settings))
        .route(
            "/v2/users/me/profile",
            get(users::me_profile).put(users::update_me_profile),
        )
        .route("/v2/users/me/login-activity", get(users::me_login_activity))
        .route(
            "/v2/users/me/preferences",
            get(users::me_preferences).put(users::update_me_preferences),
        )
        .route(
            "/v2/users/me/password",
            axum::routing::put(users::change_me_password),
        )
        .route(
            "/v2/staff/me/profile",
            get(users::staff_me_profile).put(users::update_staff_me_profile),
        )
        .route(
            "/v2/staff/me/password",
            axum::routing::put(users::change_staff_me_password),
        )
        .route(
            "/v2/staff/me/avatar",
            axum::routing::post(users::upload_staff_me_avatar)
                .delete(users::delete_staff_me_avatar)
                // Axum's default body limit is 2MB, which rejects an at-the-limit avatar before
                // the handler's own 2MB check can run. This ceiling sits above the gateway's 5MB
                // multipart cap on purpose: anything that reaches here has already been bounded,
                // so the handler is always the component that decides and can return the accurate
                // "maksimal 2MB" message instead of a generic read failure. Scoped to this method
                // router; applying it to the Router mid-chain would raise the limit for every
                // route registered before it.
                .layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route(
            "/v2/users/me/balance-history",
            get(users::me_balance_history),
        )
        .route("/v2/users/admin/list", get(users::admin_list))
        .route("/v2/users", get(users::admin_list))
        .route(
            "/v2/users/{id}",
            get(users::admin_detail)
                .put(users::update_user)
                .delete(users::delete_user),
        )
        .route(
            "/v2/users/{id}/status",
            axum::routing::patch(users::update_user_status),
        )
        .route(
            "/v2/users/{id}/openapi-key",
            axum::routing::delete(users::revoke_open_api_key),
        )
        .route("/v2/users/{id}/balance", post(users::adjust_balance))
        .route(
            "/v2/users/{id}/balance-adjustments",
            get(users::balance_adjustments),
        )
        .route("/v2/settings/admin/all", get(settings::admin_all))
        .route(
            "/v2/settings/admin/update",
            axum::routing::put(settings::admin_update),
        )
        .route(
            "/v2/settings/admin/{key}",
            get(settings::admin_detail).put(settings::admin_set),
        )
        .route(
            "/v2/margins",
            get(margins::get_margins).put(margins::update_margins),
        )
        .route("/v2/teams/admin/list", get(teams::admin_list))
        .route(
            "/v2/teams",
            get(teams::admin_list).post(teams::create_member),
        )
        .route("/v2/teams/admin/audit-logs", get(teams::audit_logs))
        .route("/v2/teams/audit-logs", get(teams::audit_logs))
        .route("/v2/teams/login-logs/all", get(teams::all_login_logs))
        .route(
            "/v2/teams/{id}",
            get(teams::admin_detail)
                .put(teams::update_member)
                .delete(teams::archive_member),
        )
        .route(
            "/v2/teams/{id}/toggle",
            axum::routing::put(teams::toggle_member),
        )
        .route(
            "/v2/teams/{id}/reset-2fa",
            axum::routing::put(teams::reset_member_two_factor),
        )
        .route("/v2/teams/{id}/login-logs", get(teams::login_logs))
        .route("/v2/upload/list", get(uploads::list_files))
        .route(
            "/v2/upload",
            axum::routing::post(uploads::upload_file)
                .delete(uploads::delete_file)
                // Single upload: total-request ceiling above the 5 MiB per-file handler limit.
                .layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route(
            "/v2/upload/multiple",
            axum::routing::post(uploads::upload_multiple)
                // Multiple upload: 24 MiB total-request ceiling so the 20 MiB aggregate file-byte
                // handler limit remains authoritative after multipart framing.
                .layer(DefaultBodyLimit::max(24 * 1024 * 1024)),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::security::enforce_two_factor_enrollment,
        ))
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(|request: &Request<_>| {
                    let path = request.uri().path();
                    let span = tracing::info_span!(
                        "http.request",
                        otel.kind = "server",
                        otel.name = %format!("{} {}", request.method(), path),
                        http.request.method = %request.method(),
                        url.path = %path,
                        webtopup.api_version = "v2",
                        trace_id = tracing::field::Empty,
                        correlation_source = tracing::field::Empty,
                        http.response.status_code = tracing::field::Empty,
                        otel.status_code = tracing::field::Empty,
                    );
                    let parent_context = global::get_text_map_propagator(|propagator| {
                        propagator.extract(&HeaderExtractor(request.headers()))
                    });
                    let _ = span.set_parent(parent_context);
                    let request_span_trace =
                        crate::services::correlation::span_correlation_trace_id_from(&span);
                    let correlation =
                        request_correlation_fields(request, request_span_trace.as_deref());
                    if let Some(trace_id) = correlation.trace_id.as_deref() {
                        span.record("trace_id", trace_id);
                    }
                    span.record("correlation_source", correlation.source.as_str());
                    span
                })
                .on_response(
                    |response: &axum::response::Response,
                     _latency: std::time::Duration,
                     span: &Span| {
                        let status = response.status().as_u16();
                        span.record("http.response.status_code", status);
                        if status >= 500 {
                            span.record("otel.status_code", "ERROR");
                        }
                    },
                ),
        )
        .layer(cors_layer())
        .with_state(state)
}

pub(crate) fn request_correlation_for_headers(
    headers: &HeaderMap,
    state: &AppState,
    request_span_trace_id: Option<&str>,
) -> crate::services::correlation::CorrelationResolution {
    resolve_request_trace_layer_correlation(headers, state, request_span_trace_id)
}

fn request_correlation_fields<B>(
    request: &Request<B>,
    request_span_trace_id: Option<&str>,
) -> crate::services::correlation::CorrelationResolution {
    let headers = request.headers();
    let Some(state) = request.extensions().get::<Arc<AppState>>() else {
        return crate::services::correlation::resolve_correlation_untrusted(
            headers,
            request_span_trace_id,
        );
    };
    request_correlation_for_headers(headers, state, request_span_trace_id)
}

struct HeaderExtractor<'a>(&'a HeaderMap);

impl Extractor for HeaderExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|value| value.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(|key| key.as_str()).collect()
    }
}

fn cors_layer() -> CorsLayer {
    let allowed_origin =
        env::var("API_V2_ALLOWED_ORIGIN").unwrap_or_else(|_| "http://localhost:9006".to_string());
    let origin = allowed_origin
        .parse::<HeaderValue>()
        .unwrap_or_else(|_| HeaderValue::from_static("http://localhost:9006"));

    CorsLayer::new()
        .allow_origin(origin)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            HeaderName::from_static("traceparent"),
            HeaderName::from_static("tracestate"),
        ])
}

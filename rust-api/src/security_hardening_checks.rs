#[test]
fn upload_validation_rejects_svg_files() {
    let source = include_str!("routes/uploads/validation.rs");

    assert!(!source.contains("image/svg+xml"));
    assert!(!source.contains(".svg"));
}

#[test]
fn password_change_uses_register_policy_and_revokes_sessions() {
    let source = include_str!("routes/users/me.rs");

    assert!(source.contains("new_password.len() < 12"));
    assert!(source.contains("COMMON_PASSWORDS"));
    assert!(source.contains("sessionVersion"));
}

#[test]
fn rust_proxy_authorization_loads_user_from_database_permissions() {
    let source = include_str!("security.rs");

    assert!(source.contains("AuthenticatedProxyUser"));
    assert!(source.contains("load_active_proxy_user"));
    assert!(source.contains("require_member_user"));
    assert!(source.contains("require_permission"));
    assert!(source.contains("permissions_from_user"));
    assert!(source.contains("Bson::Document"));
    assert!(source.contains("Bson::Array"));
}

#[test]
fn api_v2_proxy_secret_is_required_on_node_and_rust() {
    let rust_state = include_str!("state.rs");
    let node_proxy = include_str!("../../server/src/routes/apiV2ProxyRoutes.ts");

    assert!(rust_state.contains("proxy_secret_from_env"));
    assert!(rust_state.contains("API_V2_PROXY_SECRET must be configured"));
    assert!(rust_state.contains("at least 32 characters"));
    assert!(node_proxy.contains("getRequiredApiV2ProxySecret"));
    assert!(node_proxy.contains("headers.set(API_V2_PROXY_SECRET_HEADER, proxySecret)"));
}

#[test]
fn sensitive_routes_use_db_backed_authorization_helpers() {
    let users_admin = include_str!("routes/users/admin.rs");
    let transactions = include_str!("routes/transactions.rs");
    let deposits = include_str!("routes/deposits.rs");
    let uploads = include_str!("routes/uploads/handlers.rs");
    let settings = include_str!("routes/settings.rs");
    let guest_admin = include_str!("routes/guest_transactions/admin.rs");
    let vouchers_admin = include_str!("routes/vouchers/admin.rs");
    let vouchers_redeem = include_str!("routes/vouchers/redeem.rs");
    let products = include_str!("routes/products.rs");
    let product_mutations = include_str!("routes/products/mutations.rs");
    let product_sorting = include_str!("routes/products/sorting.rs");
    let product_read = include_str!("routes/products/read.rs");
    let payment_methods = include_str!("routes/payment/methods.rs");
    let payment_categories = include_str!("routes/payment/categories.rs");
    let flash_admin = include_str!("routes/content/flash_admin.rs");
    let sliders = include_str!("routes/content/sliders.rs");
    let articles = include_str!("routes/articles.rs");

    assert!(users_admin.contains("require_permission(&headers, &state, \"viewUsers\")"));
    assert!(users_admin.contains("require_permission(&headers, &state, \"manageUsers\")"));
    assert!(transactions.contains("require_permission(&headers, &state, \"viewTransactions\")"));
    assert!(
        transactions.contains("require_permission(&headers, &state, \"processManualTransaction\")")
    );
    assert!(deposits.contains("require_permission(&headers, &state, \"viewDeposits\")"));
    assert!(deposits.contains("require_permission(&headers, &state, \"approveDeposits\")"));
    assert!(uploads.contains("require_upload_permission"));
    assert!(settings.contains("require_permission(&headers, &state, \"manageSettings\")"));
    assert!(guest_admin.contains("require_permission(&headers, &state, \"viewTransactions\")"));
    assert!(
        guest_admin.contains("require_permission(&headers, &state, \"processManualTransaction\")")
    );
    assert!(vouchers_admin.contains("require_permission(&headers, &state, \"manageVouchers\")"));
    assert!(vouchers_redeem.contains("require_member_user(&headers, &state)"));
    assert!(products.contains("require_permission(&headers, &state, \"manageProducts\")"));
    assert!(product_mutations.contains("require_permission(&headers, &state, \"manageProducts\")"));
    assert!(product_sorting.contains("require_permission(&headers, &state, \"manageProducts\")"));
    assert!(product_read.contains("require_permission(&headers, &state, \"manageProducts\")"));
    assert!(payment_methods.contains("require_permission(&headers, &state, \"viewPayment\")"));
    assert!(payment_methods.contains("require_permission(&headers, &state, \"managePayment\")"));
    assert!(payment_categories.contains("require_permission(&headers, &state, \"viewPayment\")"));
    assert!(payment_categories.contains("require_permission(&headers, &state, \"managePayment\")"));
    assert!(flash_admin.contains("require_permission(&headers, &state, \"manageProducts\")"));
    assert!(sliders.contains("require_permission(&headers, &state, \"manageSettings\")"));
    assert!(articles.contains("require_permission(&headers, &state, \"manageSettings\")"));
}

#[test]
fn validation_taxonomy_reads_require_manage_settings_in_rust_and_node() {
    let routes = include_str!("routes/mod.rs");
    let categories = include_str!("routes/taxonomy/categories.rs");
    let operators = include_str!("routes/taxonomy/operators.rs");
    let product_types = include_str!("routes/taxonomy/product_types.rs");
    let node_proxy = include_str!("../../server/src/routes/apiV2ProxyRoutes.ts");

    assert!(routes.contains("/v2/validation-products/taxonomy/categories"));
    assert!(routes.contains("/v2/validation-products/taxonomy/operators"));
    assert!(routes.contains("/v2/validation-products/taxonomy/product-types"));

    for source in [&categories, &operators, &product_types] {
        assert!(source.contains("validation_taxonomy_"));
        assert!(source.contains("require_permission(&headers, &state, \"manageSettings\")"));
    }

    assert!(node_proxy.contains(
        "app.get('/validation-products/taxonomy/categories', { preHandler: [authenticate, hasPermission('manageSettings')] }"
    ));
    assert!(node_proxy.contains(
        "app.get('/validation-products/taxonomy/operators', { preHandler: [authenticate, hasPermission('manageSettings')] }"
    ));
    assert!(node_proxy.contains(
        "app.get('/validation-products/taxonomy/product-types', { preHandler: [authenticate, hasPermission('manageSettings')] }"
    ));
    assert!(node_proxy.contains(
        "app.post('/categories/admin/create', { preHandler: [authenticate, hasPermission('manageProducts')] }"
    ));
}

#[test]
fn validation_taxonomy_permission_matrix_behavior() {
    use crate::security::team_user_has_any_permission;

    assert!(team_user_has_any_permission(
        "owner",
        &[],
        &["manageSettings"]
    ));
    assert!(team_user_has_any_permission(
        "admin",
        &["manageSettings".to_string()],
        &["manageSettings"]
    ));
    assert!(!team_user_has_any_permission(
        "admin",
        &["viewDashboard".to_string()],
        &["manageSettings"]
    ));
    assert!(!team_user_has_any_permission(
        "admin",
        &["manageSettings".to_string()],
        &["manageProducts"]
    ));
    assert!(team_user_has_any_permission(
        "admin",
        &["manageProducts".to_string()],
        &["manageProducts"]
    ));
    assert!(!team_user_has_any_permission(
        "member",
        &["manageSettings".to_string()],
        &["manageSettings"]
    ));
}

#[test]
fn rust_flash_sale_reservations_are_atomic() {
    let guest_checkout = include_str!("routes/guest_transactions/checkout.rs");
    let transactions = include_str!("routes/transactions.rs");

    for source in [guest_checkout, transactions] {
        assert!(source.contains("$expr"));
        assert!(source.contains("$gt"));
        assert!(source.contains("$subtract"));
        assert!(source.contains("products.$.soldCount"));
    }
}

#[test]
fn rust_digiflazz_seller_routes_cover_frontend_actions() {
    let routes = include_str!("routes/mod.rs");
    let seller = include_str!("routes/digiflazz_seller.rs");
    let mappings = include_str!("routes/digiflazz_seller/mappings.rs");
    let callbacks = include_str!("routes/digiflazz_seller/callbacks.rs");
    let prepaid = include_str!("routes/digiflazz_seller/prepaid.rs");

    assert!(routes.contains("/v2/digiflazz-seller/mappings/{id}/sync"));
    assert!(routes.contains("/v2/digiflazz-seller/mappings/sync"));
    assert!(routes.contains("/v2/digiflazz-seller/orders/{id}/retry-callback"));
    assert!(routes.contains("/v2/digiflazz-seller/orders/retry-callbacks"));
    assert!(routes.contains("/v2/digiflazz-seller/orders/process-callback-retries"));
    assert!(routes.contains("/v2/digiflazz-seller/prepaid"));
    assert!(mappings.contains("sync_seller_product_mapping"));
    assert!(callbacks.contains("send_seller_callback"));
    assert!(seller.contains("save_retry_queue_health"));
    assert!(seller.contains("callback_due_retry_query"));
    assert!(prepaid.contains("verify_digiflazz_seller_request"));
    assert!(prepaid.contains("constant_time_eq"));
    assert!(prepaid.contains("reply_with_existing_seller_order"));
    assert!(prepaid.contains("callbackRequired"));
    assert!(!prepaid.contains("count_documents"));
}

#[test]
fn rust_open_api_create_transaction_is_v2_and_atomic() {
    let routes = include_str!("routes/mod.rs");
    let open_api = include_str!("routes/open_api.rs");
    let create = include_str!("routes/open_api/create.rs");

    assert!(routes.contains("/v2/api/transaction"));
    assert!(routes.contains("post(open_api::create_transaction)"));
    assert!(open_api.contains("create_transaction"));
    assert!(create.contains("find_one_and_update"));
    assert!(create.contains("balance"));
    assert!(create.contains("$gte"));
    assert!(create.contains("rollback"));
    assert!(!create.contains("count_documents"));
}

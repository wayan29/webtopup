mod audit;
mod log_handlers;
mod logs;
mod mappers;
mod member_create;
mod member_reads;
mod member_status;
mod member_update;
mod queries;
mod responses;
mod security;
mod session;
mod types;
mod validation;

pub use log_handlers::{all_login_logs, audit_logs, login_logs};
pub use member_create::create_member;
pub use member_reads::{admin_detail, admin_list};
pub use member_status::{archive_member, toggle_member};
pub use member_update::update_member;
pub use security::reset_member_two_factor;

const TEAM_PERMISSIONS: [&str; 19] = [
    "viewDashboard",
    "viewReports",
    "viewTransactions",
    "processManualTransaction",
    "viewDeposits",
    "approveDeposits",
    "viewProducts",
    "manageProducts",
    "manageVouchers",
    "viewPayment",
    "managePayment",
    "viewUsers",
    "manageUsers",
    "viewTeam",
    "manageTeam",
    "viewSettings",
    "manageSettings",
    "viewVendors",
    "manageVendors",
];

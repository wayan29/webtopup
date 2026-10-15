mod log_handlers;
mod responses;
mod sql_members;
mod types;
mod validation;

pub use log_handlers::{all_login_logs, audit_logs, login_logs};
pub use sql_members::{admin_detail, admin_list, archive_member, create_member, reset_member_two_factor, toggle_member, update_member};

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

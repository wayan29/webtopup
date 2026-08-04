mod cache;
mod handlers;
pub(in crate::routes) mod normalize;
pub(in crate::routes) mod operators;
pub(in crate::routes) mod provider;
pub(in crate::routes) mod types;

pub use handlers::{freefire, mobilelegends, operator};

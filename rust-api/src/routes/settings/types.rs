use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
pub struct SetSettingPayload {
    pub value: Value,
}

use rand::RngCore;

pub fn generate_api_key() -> String {
    let mut bytes = [0_u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    let key = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("tv_{key}")
}

pub fn generate_api_secret() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

pub fn member_code_from_uuid(id: uuid::Uuid) -> String {
    let text = id.simple().to_string();
    format!("MBR{}", text[22..].to_uppercase())
}

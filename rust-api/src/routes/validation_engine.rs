use super::validate::{
    normalize::{normalize_digit_input, normalize_phone_input},
    operators::operators,
    provider::{inquire_freefire_nickname, inquire_mobilelegends_nickname},
    types::NicknameResultKind,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::routes) enum PaidValidationStatus {
    Success,
    Failed,
    ProviderError,
}

#[derive(Clone, Debug)]
pub(in crate::routes) struct PaidValidationConfig {
    pub(in crate::routes) validation_type: String,
    pub(in crate::routes) game: String,
    pub(in crate::routes) result_label: String,
}

#[derive(Clone, Debug)]
pub(in crate::routes) struct PaidValidationResult {
    pub(in crate::routes) status: PaidValidationStatus,
    pub(in crate::routes) message: String,
    pub(in crate::routes) sn: Option<String>,
}

pub(in crate::routes) fn product_validation_config_json(product: &serde_json::Value) -> Option<PaidValidationConfig> {
    let validation=product.get("validation")?;
    if !validation.get("enabled")?.as_bool()? { return None; }
    let validation_type=validation.get("type")?.as_str()?.to_owned();
    if !matches!(validation_type.as_str(),"nickname"|"operator") { return None; }
    let game=validation.get("game").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned();
    if (validation_type=="nickname"&&!matches!(game.as_str(),"freefire"|"mobilelegends"))||(validation_type=="operator"&&!game.is_empty()){return None}
    let result_label=validation.get("resultLabel").and_then(serde_json::Value::as_str).filter(|s|!s.is_empty()).unwrap_or("Hasil").to_owned();
    Some(PaidValidationConfig{validation_type,game,result_label})
}

pub(in crate::routes) async fn run_paid_validation(
    config: &PaidValidationConfig,
    target: &str,
    secondary_target: &str,
) -> PaidValidationResult {
    match config.validation_type.as_str() {
        "operator" => run_operator_validation(config, target),
        "nickname" => run_nickname_validation(config, target, secondary_target).await,
        _ => PaidValidationResult {
            status: PaidValidationStatus::Failed,
            message: format!("Tipe validasi '{}' tidak didukung", config.validation_type),
            sn: None,
        },
    }
}

fn run_operator_validation(config: &PaidValidationConfig, target: &str) -> PaidValidationResult {
    let normalized = normalize_phone_input(Some(target.to_string()));
    let Some(phone_number) = normalized.value else {
        return PaidValidationResult {
            status: PaidValidationStatus::Failed,
            message: normalized
                .message
                .unwrap_or_else(|| "Nomor HP tidak valid".to_string()),
            sn: None,
        };
    };
    if phone_number.len() < 10 {
        return PaidValidationResult {
            status: PaidValidationStatus::Failed,
            message: "Nomor HP tidak valid".to_string(),
            sn: None,
        };
    }
    let prefix = phone_number.chars().take(4).collect::<String>();
    if let Some(operator) = operators()
        .iter()
        .find(|operator| operator.prefixes.contains(&prefix.as_str()))
    {
        let sn = format!("{}: {}", config.result_label, operator.name);
        return PaidValidationResult {
            status: PaidValidationStatus::Success,
            message: "Operator berhasil dideteksi".to_string(),
            sn: Some(sn),
        };
    }
    PaidValidationResult {
        status: PaidValidationStatus::Failed,
        message: "Operator tidak dapat diidentifikasi".to_string(),
        sn: None,
    }
}

async fn run_nickname_validation(
    config: &PaidValidationConfig,
    target: &str,
    secondary_target: &str,
) -> PaidValidationResult {
    let normalized_user_id = normalize_digit_input(Some(target.to_string()), "User ID", 5, 20);
    let Some(user_id) = normalized_user_id.value else {
        return PaidValidationResult {
            status: PaidValidationStatus::Failed,
            message: normalized_user_id
                .message
                .unwrap_or_else(|| "User ID tidak valid".to_string()),
            sn: None,
        };
    };

    let result = if config.game == "mobilelegends" {
        let normalized_zone_id =
            normalize_digit_input(Some(secondary_target.to_string()), "Zone ID", 1, 10);
        let Some(zone_id) = normalized_zone_id.value else {
            return PaidValidationResult {
                status: PaidValidationStatus::Failed,
                message: normalized_zone_id
                    .message
                    .unwrap_or_else(|| "Zone ID tidak valid".to_string()),
                sn: None,
            };
        };
        inquire_mobilelegends_nickname(&user_id, &zone_id).await
    } else {
        inquire_freefire_nickname(&user_id).await
    };

    if result.is_success {
        let nickname = result.nickname.unwrap_or_default();
        return PaidValidationResult {
            status: PaidValidationStatus::Success,
            message: result
                .message
                .unwrap_or_else(|| "Nickname berhasil ditemukan".to_string()),
            sn: Some(format!("{}: {}", config.result_label, nickname)),
        };
    }

    map_nickname_failure_to_paid_result(&result)
}

pub(in crate::routes) fn map_nickname_failure_to_paid_result(
    result: &super::validate::types::NicknameResult,
) -> PaidValidationResult {
    PaidValidationResult {
        status: if result.kind == NicknameResultKind::ProviderError {
            PaidValidationStatus::ProviderError
        } else {
            PaidValidationStatus::Failed
        },
        message: result
            .message
            .clone()
            .unwrap_or_else(|| "Nickname tidak ditemukan".to_string()),
        sn: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::validate::types::{NicknameResult, NicknameResultKind};

    #[test]
    fn provider_error_maps_to_pending_status() {
        let result = NicknameResult {
            is_success: false,
            kind: NicknameResultKind::ProviderError,
            nickname: None,
            message: Some(
                "Layanan validasi sedang mengalami gangguan. Coba lagi beberapa saat.".to_string(),
            ),
        };
        let paid = map_nickname_failure_to_paid_result(&result);
        assert_eq!(paid.status, PaidValidationStatus::ProviderError);
    }

    #[test]
    fn explicit_not_found_maps_to_failed() {
        let result = NicknameResult {
            is_success: false,
            kind: NicknameResultKind::NotFound,
            nickname: None,
            message: Some("User ID tidak valid".to_string()),
        };
        let paid = map_nickname_failure_to_paid_result(&result);
        assert_eq!(paid.status, PaidValidationStatus::Failed);
    }

    #[test]
    fn throttle_outage_does_not_map_to_failed() {
        let result = NicknameResult {
            is_success: false,
            kind: NicknameResultKind::ProviderError,
            nickname: None,
            message: Some("throttle".to_string()),
        };
        let paid = map_nickname_failure_to_paid_result(&result);
        assert_ne!(paid.status, PaidValidationStatus::Failed);
    }
}

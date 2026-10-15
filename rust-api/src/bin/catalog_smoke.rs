use std::{env, process::ExitCode};
#[path = "../catalog_store.rs"]
mod catalog_store;
use catalog_store::{CatalogError, CatalogStore};

#[tokio::main]
async fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let action = args.next().unwrap_or_default();
    let Ok(url) = env::var("DATABASE_URL") else {
        return ExitCode::from(2);
    };
    let Ok(store) = CatalogStore::connect(&url).await else {
        return ExitCode::from(3);
    };
    let values: Vec<_> = args.collect();
    let result = match action.as_str() {
        "create" if values.len() == 4 => store
            .create_product(&values[0], &values[1], &values[2], &values[3])
            .await
            .map(|id| println!("{id}")),
        "delete-category" if values.len() == 1 => {
            store.delete_category(&values[0]).await.map(|_| ())
        }
        "sync" if values.len() == 6 => {
            let (Ok(cost), Ok(basic), Ok(gold), Ok(platinum)) = (
                values[2].parse::<i64>(),
                values[3].parse::<f64>(),
                values[4].parse::<f64>(),
                values[5].parse::<f64>(),
            ) else {
                return ExitCode::from(2);
            };
            store
                .sync_vendor_price(&values[0], &values[1], cost, (basic, gold, platinum))
                .await
                .map(|prices| println!("{} {} {}", prices.0, prices.1, prices.2))
        }
        "payment" if values.len() == 1 => store
            .create_payment_method(&values[0])
            .await
            .map(|id| println!("{id}")),
        "reference" if values.len() == 1 || values.len() == 2 => {
            let Ok(id) = values[0].parse() else {
                return ExitCode::from(2);
            };
            let now = if let Some(value) = values.get(1) {
                match chrono::DateTime::parse_from_rfc3339(value) {
                    Ok(value) => value.with_timezone(&chrono::Utc),
                    Err(_) => return ExitCode::from(2),
                }
            } else {
                chrono::Utc::now()
            };
            store
                .allocate_reference(id, now)
                .await
                .map(|reference| println!("{reference}"))
        }
        "delete-payment" if values.len() == 1 => {
            let Ok(id) = values[0].parse() else {
                return ExitCode::from(2);
            };
            store.delete_payment_method(id).await.map(|_| ())
        }
        _ => return ExitCode::from(2),
    };
    match result {
        Ok(_) => ExitCode::SUCCESS,
        Err(CatalogError::Conflict) => ExitCode::from(11),
        Err(CatalogError::Unavailable) => ExitCode::from(3),
    }
}

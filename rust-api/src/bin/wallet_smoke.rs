use std::{env, process::ExitCode};
#[path = "../wallet_store.rs"]
mod wallet_store;
use wallet_store::{WalletError, WalletStore};

#[tokio::main]
async fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let action = args.next().unwrap_or_default();
    let Ok(url) = env::var("DATABASE_URL") else { return ExitCode::from(2); };
    let Ok(store) = WalletStore::connect(&url).await else { return ExitCode::from(3); };
    if action == "guest-checkout" || action == "guest-lookup" || action == "race-guest" {
        let values: Vec<_> = args.collect();
        if action == "guest-lookup" && values.len() == 1 {
            return match store.public_guest_lookup(&values[0]).await { Ok(Some((invoice, price, status))) => { println!("{invoice} {price} {status}"); ExitCode::SUCCESS }, Ok(None) => ExitCode::from(4), Err(error) => code(error) };
        }
        if action == "race-guest" && values.len() == 4 {
            let at = values[3].parse().unwrap_or_default();
            let left_key = format!("{}-a", values[0]);
            let right_key = format!("{}-b", values[0]);
            let left_invoice = format!("{}-A", values[2]);
            let right_invoice = format!("{}-B", values[2]);
            let (left, right) = tokio::join!(store.guest_checkout(&left_key, &values[1], &left_invoice, "ML10", at), store.guest_checkout(&right_key, &values[1], &right_invoice, "ML10", at));
            println!("{} {}", left.is_ok(), right.is_ok());
            return ExitCode::SUCCESS;
        }
        if values.len() != 5 { return ExitCode::from(2); }
        let Ok(at) = values[4].parse() else { return ExitCode::from(2); };
        return match store.guest_checkout(&values[0], &values[1], &values[2], &values[3], at).await { Ok(price) => { println!("{price}"); ExitCode::SUCCESS }, Err(error) => code(error) };
    }
    if action.starts_with("provider-") {
        let values: Vec<_> = args.collect();
        let result = match action.as_str() {
            "provider-enqueue" if values.len() == 2 => store.enqueue_provider(&values[0], &values[1]).await.map(|_| ()),
            "provider-claim" if values.len() == 1 => store.claim_provider(&values[0]).await.map(|generation| println!("{generation}")),
            "provider-ambiguous" if values.len() == 2 => { let Ok(generation) = values[1].parse() else { return ExitCode::from(2); }; store.mark_provider_ambiguous(&values[0], generation).await }
            "provider-reconcile" if values.len() == 2 => store.reconcile_provider(&values[0], &values[1]).await,
            _ => return ExitCode::from(2),
        };
        return match result { Ok(()) => ExitCode::SUCCESS, Err(error) => code(error) };
    }
    if action == "seller-claim" || action == "seller-fail" || action == "seller-due" {
        let values: Vec<_> = args.collect();
        let result = match action.as_str() {
            "seller-claim" if values.len() == 2 => store.claim_seller_callback(&values[0], &values[1]).await.map(|ok| println!("{ok}")),
            "seller-fail" if values.len() == 2 => store.fail_seller_callback(&values[0], &values[1]).await.map(|ok| println!("{ok}")),
            "seller-due" if values.len() == 1 => { let Ok(limit) = values[0].parse() else { return ExitCode::from(2); }; store.process_due_seller_callbacks(limit).await.map(|row| println!("{} {} {} {}", row.0, row.1, row.2, row.3)) }
            _ => return ExitCode::from(2),
        };
        return match result { Ok(()) => ExitCode::SUCCESS, Err(error) => code(error) };
    }

    let Some(Ok(user_id)) = args.next().map(|value| value.parse()) else { return ExitCode::from(2); };
    if action == "webhook" {
        let values: Vec<_> = args.collect();
        if values.len() != 5 { return ExitCode::from(2); }
        let Ok(amount) = values[4].parse::<i64>() else { return ExitCode::from(2); };
        let body = format!("{{\"ref_id\":\"{}\",\"status\":\"{}\"}}", values[1], values[2]).into_bytes();
        let signature = wallet_store::sign_webhook(b"webhook-secret", &body);
        let provided = if values[3] == "bad" { "sha1=00".to_string() } else { format!("sha1={signature}") };
        return match store.apply_financial_webhook(&values[0], &values[1], &values[2], &body, &provided, "webhook-secret", user_id, amount).await { Ok(result) => { println!("{result}"); ExitCode::SUCCESS }, Err(error) => code(error) };
    }
    if action == "reconcile" {
        return match store.reconcile(user_id).await { Ok(ok) => { println!("{ok}"); ExitCode::SUCCESS }, Err(error) => code(error) };
    }
    if action == "race-debit" {
        let values: Vec<_> = args.collect();
        if values.len() != 2 { return ExitCode::from(2); }
        let Ok(amount) = values[1].parse::<i64>() else { return ExitCode::from(2); };
        let left_source = format!("{}-a", values[0]);
        let right_source = format!("{}-b", values[0]);
        let (left, right) = tokio::join!(store.debit(user_id, &left_source, amount), store.debit(user_id, &right_source, amount));
        println!("{} {}", left.is_ok(), right.is_ok());
        return ExitCode::SUCCESS;
    }
    if action == "idempotent" {
        let values: Vec<_> = args.collect();
        if values.len() != 3 { return ExitCode::from(2); }
        let Ok(amount) = values[2].parse::<i64>() else { return ExitCode::from(2); };
        return match store.idempotent_credit(user_id, &values[0], &values[1], amount).await { Ok(balance) => { println!("{balance}"); ExitCode::SUCCESS }, Err(error) => code(error) };
    }
    if action == "checkout" {
        let values: Vec<_> = args.collect();
        if values.len() != 4 { return ExitCode::from(2); }
        return match store.checkout(user_id, &values[0], &values[1], &values[2], &values[3]).await { Ok(balance) => { println!("{balance}"); ExitCode::SUCCESS }, Err(error) => code(error) };
    }
    if action == "checkout-abort" {
        let values: Vec<_> = args.collect();
        if values.len() != 4 { return ExitCode::from(2); }
        return match store.checkout_then_abort(user_id, &values[0], &values[1], &values[2], &values[3]).await { Ok(balance) => { println!("{balance}"); ExitCode::SUCCESS }, Err(error) => code(error) };
    }
    if action == "race-checkout" {
        let values: Vec<_> = args.collect();
        if values.len() != 3 { return ExitCode::from(2); }
        let left_key = format!("{}-a", values[0]);
        let right_key = format!("{}-b", values[0]);
        let (left, right) = tokio::join!(store.checkout(user_id, &left_key, &values[1], &values[2], "gold"), store.checkout(user_id, &right_key, &values[1], &values[2], "gold"));
        println!("{} {}", left.is_ok(), right.is_ok());
        return ExitCode::SUCCESS;
    }
    if matches!(action.as_str(), "approve-deposit" | "race-approve" | "refund-deposit" | "adjust") {
        let values: Vec<_> = args.collect();
        let result = match action.as_str() {
            "approve-deposit" if values.len() == 2 => { let (Ok(actor), Ok(deposit)) = (values[0].parse(), values[1].parse()) else { return ExitCode::from(2); }; store.approve_deposit(actor, false, deposit).await.map(|balance| println!("{balance}")) }
            "race-approve" if values.len() == 3 => { let (Ok(left_actor), Ok(right_actor), Ok(deposit)) = (values[0].parse(), values[1].parse(), values[2].parse()) else { return ExitCode::from(2); }; let (left, right) = tokio::join!(store.approve_deposit(left_actor, false, deposit), store.approve_deposit(right_actor, true, deposit)); println!("{} {}", left.is_ok(), right.is_ok()); return ExitCode::SUCCESS; }
            "refund-deposit" if values.len() == 3 => { let (Ok(actor), Ok(deposit)) = (values[0].parse(), values[1].parse()) else { return ExitCode::from(2); }; store.refund_deposit(actor, deposit, &values[2]).await.map(|balance| println!("{balance}")) }
            "adjust" if values.len() == 3 => { let (Ok(actor), Ok(amount)) = (values[0].parse(), values[2].parse()) else { return ExitCode::from(2); }; store.adjust_balance(actor, user_id, &values[1], amount).await.map(|balance| println!("{balance}")) }
            _ => return ExitCode::from(2),
        };
        return match result { Ok(()) => ExitCode::SUCCESS, Err(error) => code(error) };
    }
    let (Some(source), Some(Ok(amount))) = (args.next(), args.next().map(|value| value.parse())) else { return ExitCode::from(2); };
    let result = match action.as_str() {
        "credit" => store.credit(user_id, &source, amount).await,
        "debit" => store.debit(user_id, &source, amount).await,
        "refund" => store.refund(user_id, &source, amount).await,
        "abort" => store.credit_then_abort(user_id, &source, amount).await,
        _ => return ExitCode::from(2),
    };
    match result { Ok(balance) => { println!("{balance}"); ExitCode::SUCCESS }, Err(error) => code(error) }
}

fn code(error: WalletError) -> ExitCode {
    match error { WalletError::Insufficient => ExitCode::from(12), WalletError::Conflict => ExitCode::from(11), WalletError::Unavailable => ExitCode::from(3) }
}

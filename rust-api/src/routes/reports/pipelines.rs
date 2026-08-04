use mongodb::bson::{doc, Bson, Document};

const SALES_REPORT_EXPORT_LIMIT: i64 = 5000;

pub(super) fn build_sales_pipeline(date_match: Document) -> Vec<Document> {
    let mut pipeline = Vec::new();
    if !date_match.is_empty() {
        pipeline.push(doc! { "$match": date_match });
    }

    pipeline.extend([
        doc! {
            "$lookup": {
                "from": "products",
                "localField": "product",
                "foreignField": "_id",
                "as": "product"
            }
        },
        doc! { "$unwind": { "path": "$product", "preserveNullAndEmptyArrays": true } },
        doc! {
            "$lookup": {
                "from": "users",
                "localField": "user",
                "foreignField": "_id",
                "as": "user"
            }
        },
        doc! { "$unwind": { "path": "$user", "preserveNullAndEmptyArrays": true } },
        doc! { "$addFields": { "trackedProfit": tracked_profit_expression() } },
        doc! {
            "$facet": {
                "summary": [{
                    "$group": {
                        "_id": null,
                        "totalTransactions": { "$sum": 1 },
                        "successTransactions": { "$sum": { "$cond": [{ "$eq": ["$status", "success"] }, 1, 0] } },
                        "pendingTransactions": { "$sum": { "$cond": [{ "$in": ["$status", ["pending", "processing"]] }, 1, 0] } },
                        "failedTransactions": { "$sum": { "$cond": [{ "$eq": ["$status", "failed"] }, 1, 0] } },
                        "totalOmset": { "$sum": { "$cond": [{ "$eq": ["$status", "success"] }, "$amount", 0] } },
                        "totalProfit": { "$sum": "$trackedProfit" }
                    }
                }],
                "categoryData": [
                    { "$match": { "status": "success" } },
                    { "$group": { "_id": { "$ifNull": ["$product.category", "Uncategorized"] }, "count": { "$sum": 1 }, "omset": { "$sum": "$amount" }, "profit": { "$sum": "$trackedProfit" } } },
                    { "$project": { "_id": 0, "category": "$_id", "count": 1, "omset": 1, "profit": 1 } },
                    { "$sort": { "omset": -1, "category": 1 } }
                ],
                "dailyData": [
                    { "$match": { "status": "success" } },
                    { "$group": { "_id": { "$dateToString": { "format": "%Y-%m-%d", "date": "$createdAt", "timezone": "Asia/Jakarta" } }, "count": { "$sum": 1 }, "omset": { "$sum": "$amount" }, "profit": { "$sum": "$trackedProfit" } } },
                    { "$project": { "_id": 0, "date": "$_id", "count": 1, "omset": 1, "profit": 1 } },
                    { "$sort": { "date": 1 } }
                ],
                "recentTransactions": [
                    { "$sort": { "createdAt": -1 } },
                    { "$limit": 10 },
                    { "$project": { "_id": 1, "product": { "$ifNull": ["$product.name", "Unknown"] }, "category": { "$ifNull": ["$product.category", "Unknown"] }, "user": { "$ifNull": ["$user.name", "Unknown"] }, "target": 1, "amount": 1, "status": 1, "createdAt": 1 } }
                ]
            }
        },
    ]);

    pipeline
}

pub(super) fn build_sales_export_pipeline(mut date_match: Document) -> Vec<Document> {
    date_match.insert("status", "success");
    vec![
        doc! { "$match": date_match },
        doc! {
            "$lookup": {
                "from": "products",
                "localField": "product",
                "foreignField": "_id",
                "as": "product"
            }
        },
        doc! { "$unwind": { "path": "$product", "preserveNullAndEmptyArrays": true } },
        doc! {
            "$lookup": {
                "from": "users",
                "localField": "user",
                "foreignField": "_id",
                "as": "user"
            }
        },
        doc! { "$unwind": { "path": "$user", "preserveNullAndEmptyArrays": true } },
        doc! { "$sort": { "createdAt": -1 } },
        doc! { "$limit": SALES_REPORT_EXPORT_LIMIT },
        doc! {
            "$project": {
                "_id": 1,
                "createdAt": 1,
                "target": 1,
                "amount": 1,
                "status": 1,
                "product.name": 1,
                "product.code": 1,
                "product.category": 1,
                "product.brand": 1,
                "product.costPrice": 1,
                "product.vendor.name": 1,
                "user.name": 1,
                "user.email": 1,
            }
        },
    ]
}

pub(super) fn tracked_profit_expression() -> Bson {
    Bson::Document(doc! {
        "$cond": [
            {
                "$and": [
                    { "$eq": ["$status", "success"] },
                    { "$gt": [{ "$ifNull": ["$product.costPrice", 0] }, 0] }
                ]
            },
            { "$subtract": ["$amount", { "$ifNull": ["$product.costPrice", 0] }] },
            0
        ]
    })
}

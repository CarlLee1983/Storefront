-- 0020_stock_ledger 套用後的唯讀核對：每個查詢回傳的列都是需要人工處理的例外，全部為空才算通過。
-- 用法：wrangler d1 execute <DB> --file apps/app/scripts/verify-0020-stock.sql（加 --local／--remote／--env）。

-- 1. 狀態是已付款，卻找不到讓它轉為已付款的成功付款：遷移仍照舊系統語意（已付款就已扣庫）加回，但付款證據對不上，須人工確認
SELECT 'paid_without_succeeded_payment' AS exception, ord.id AS order_id, NULL AS variant_id
FROM orders ord
WHERE ord.status = 'paid'
  AND NOT EXISTS (SELECT 1 FROM payments pay WHERE pay.id = ord.paid_by_payment_id AND pay.status IN ('succeeded', 'refunded', 'refund_failed'));

-- 2. 可售量為負：在庫數低於待付款與已付款保留的總和，表示加回後仍對不上（舊資料已超賣或手動改過庫存）
SELECT 'negative_available' AS exception, NULL AS order_id, variant.id AS variant_id
FROM product_variants variant
WHERE variant.on_hand - COALESCE((
  SELECT SUM(line.quantity) FROM order_lines line JOIN orders ord ON ord.id = line.order_id
  WHERE line.variant_id = variant.id AND ord.status IN ('pending_payment', 'paid')
), 0) < 0;

-- 3. 流水與在庫數對不上：有流水的變體，最後一筆的「之後在庫數」必須等於目前在庫數
SELECT 'ledger_mismatch' AS exception, NULL AS order_id, variant.id AS variant_id
FROM product_variants variant
WHERE EXISTS (SELECT 1 FROM stock_movements m WHERE m.variant_id = variant.id)
  AND variant.on_hand <> (SELECT m.on_hand_after FROM stock_movements m WHERE m.variant_id = variant.id ORDER BY m.id DESC LIMIT 1);

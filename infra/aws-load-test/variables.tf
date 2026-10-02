variable "aws_region" {
  description = "AWS IoT Coreを確認するリージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "rule_name" {
  description = "Basic Ingestで呼び出すIoT Rule名"
  type        = string
  default     = "drone_fleet_load_test"
}

variable "certificate_arn" {
  description = "Phase 2で発行し、ローカルに秘密鍵を保管した有効な証明書ARN"
  type        = string
}

variable "budget_notification_email" {
  description = "AWS IoTの課金を通知するメールアドレス。空文字の場合はBudgetを作成しない"
  type        = string
  default     = ""
}

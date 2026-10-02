variable "environment" {
  description = "リソース名とバックエンドclientIdに使う環境名"
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.environment))
    error_message = "environment must be 2-20 lowercase letters, numbers, or hyphens and start with a letter"
  }
}

variable "aws_region" {
  description = "AWS IoT Coreを作成するリージョン"
  type        = string
  default     = "ap-northeast-1"

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]+$", var.aws_region))
    error_message = "aws_region must be a valid AWS region name"
  }
}

variable "device_ids" {
  description = "Thing nameとして登録するdeviceIdの集合。証明書は別途#93で関連付ける"
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for device_id in var.device_ids :
      can(regex("^[A-Za-z0-9_-]{1,64}$", device_id))
    ])
    error_message = "device_ids must contain only 1-64 letters, numbers, hyphens, or underscores"
  }
}

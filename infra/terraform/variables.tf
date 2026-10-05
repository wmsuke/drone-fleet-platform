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

variable "device_certificate_arns" {
  description = "発行済みdeviceIdごとのAWS IoT certificate ARN。初回のThing作成時は空mapを許可する"
  type        = map(string)
  default     = {}

  validation {
    condition     = length(setsubtract(toset(keys(var.device_certificate_arns)), var.device_ids)) == 0
    error_message = "device_certificate_arns keys must be included in device_ids"
  }

  validation {
    condition = alltrue([
      for certificate_arn in values(var.device_certificate_arns) :
      can(regex("^arn:[a-z0-9-]+:iot:${var.aws_region}:[0-9]{12}:cert/[a-fA-F0-9]{64}$", certificate_arn))
    ])
    error_message = "device_certificate_arns must contain AWS IoT certificate ARNs in aws_region"
  }
}

variable "telemetry_ingestor_certificate_arn" {
  description = "telemetry-ingestor専用AWS IoT certificate ARN。未発行時はnull"
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.telemetry_ingestor_certificate_arn == null ||
      can(regex("^arn:[a-z0-9-]+:iot:${var.aws_region}:[0-9]{12}:cert/[a-fA-F0-9]{64}$", var.telemetry_ingestor_certificate_arn))
    )
    error_message = "telemetry_ingestor_certificate_arn must be an AWS IoT certificate ARN in aws_region"
  }

  validation {
    condition = (
      var.telemetry_ingestor_certificate_arn == null ||
      !contains(values(var.device_certificate_arns), var.telemetry_ingestor_certificate_arn)
    )
    error_message = "telemetry_ingestor_certificate_arn must differ from every device certificate ARN"
  }
}

variable "api_certificate_arn" {
  description = "API専用AWS IoT certificate ARN。未発行時はnull"
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.api_certificate_arn == null ||
      can(regex("^arn:[a-z0-9-]+:iot:${var.aws_region}:[0-9]{12}:cert/[a-fA-F0-9]{64}$", var.api_certificate_arn))
    )
    error_message = "api_certificate_arn must be an AWS IoT certificate ARN in aws_region"
  }

  validation {
    condition = (
      var.api_certificate_arn == null ||
      !contains(values(var.device_certificate_arns), var.api_certificate_arn)
    )
    error_message = "api_certificate_arn must differ from every device certificate ARN"
  }

  validation {
    condition = (
      var.api_certificate_arn == null ||
      var.telemetry_ingestor_certificate_arn == null ||
      var.api_certificate_arn != var.telemetry_ingestor_certificate_arn
    )
    error_message = "api_certificate_arn must differ from telemetry_ingestor_certificate_arn"
  }
}

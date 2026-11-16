variable "project_id" {
  type        = string
  description = "Scaleway project ID."
}

variable "region" {
  type        = string
  description = "Scaleway region."
  default     = "fr-par"
}

variable "zone" {
  type        = string
  description = "Scaleway zone."
  default     = "fr-par-1"
}

variable "control_instance_type" {
  type        = string
  description = "DEV1-S is enough for the SQLite control plane."
  default     = "DEV1-S"
}

variable "allowed_cidrs" {
  type        = list(string)
  description = "Public source CIDRs allowed to reach SSH and the temporary control API port."
}

variable "create_ios_worker" {
  type        = bool
  description = "Order the optional Apple-silicon worker. It has a 24-hour minimum allocation."
  default     = false
}

variable "ios_worker_type" {
  type        = string
  description = "M1-M is cheapest; use M4-XL for the highest simulator density."
  default     = "M1-M"
}

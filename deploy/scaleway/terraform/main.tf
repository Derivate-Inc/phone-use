resource "scaleway_instance_ip" "control" {
  project_id = var.project_id
}

resource "scaleway_instance_security_group" "control" {
  project_id              = var.project_id
  name                    = "phone-use-control"
  inbound_default_policy  = "drop"
  outbound_default_policy = "accept"

  dynamic "inbound_rule" {
    for_each = var.allowed_cidrs
    content {
      action   = "accept"
      port     = 22
      protocol = "TCP"
      ip_range = inbound_rule.value
    }
  }

  inbound_rule {
    action   = "accept"
    port     = 80
    protocol = "TCP"
    ip_range = "0.0.0.0/0"
  }

  inbound_rule {
    action   = "accept"
    port     = 443
    protocol = "TCP"
    ip_range = "0.0.0.0/0"
  }

  dynamic "inbound_rule" {
    for_each = var.allowed_cidrs
    content {
      action   = "accept"
      port     = 8080
      protocol = "TCP"
      ip_range = inbound_rule.value
    }
  }
}

resource "scaleway_apple_silicon_server" "ios_worker" {
  count      = var.create_ios_worker ? 1 : 0
  project_id = var.project_id
  zone       = var.zone
  name       = "phone-use-ios-worker"
  type       = var.ios_worker_type
}

resource "scaleway_instance_server" "control" {
  project_id        = var.project_id
  name              = "phone-use-control"
  type              = var.control_instance_type
  image             = "ubuntu_noble"
  ip_id             = scaleway_instance_ip.control.id
  security_group_id = scaleway_instance_security_group.control.id
  tags              = ["phone-use", "control-plane"]

  root_volume {
    size_in_gb            = 20
    delete_on_termination = true
  }
}

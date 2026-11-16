output "control_public_ip" {
  description = "SSH/bootstrap address for the control plane."
  value       = scaleway_instance_ip.control.address
}

output "control_api_url_before_tls" {
  description = "Temporary CIDR-restricted URL. Put TLS in front before sending tokens over the internet."
  value       = "http://${scaleway_instance_ip.control.address}:8080"
}

output "ios_worker_ip" {
  description = "Apple-silicon worker IP when create_ios_worker is enabled."
  value       = try(scaleway_apple_silicon_server.ios_worker[0].ip, null)
}

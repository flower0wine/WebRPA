/**
 * IP 地址处理工具
 */

/**
 * 获取客户端真实 IP 地址
 * 支持代理和负载均衡场景
 */
export function getClientIP(req) {
  // 优先从代理头获取
  const forwardedFor = req.headers['x-forwarded-for']
  if (forwardedFor) {
    // 取第一个 IP（最原始的客户端 IP）
    const ips = forwardedFor.split(',').map(ip => ip.trim())
    const clientIP = ips[0]
    if (isValidIP(clientIP)) {
      return clientIP
    }
  }

  // 其他常见代理头
  const realIP = req.headers['x-real-ip']
  if (realIP && isValidIP(realIP)) {
    return realIP
  }

  // Cloudflare
  const cfIP = req.headers['cf-connecting-ip']
  if (cfIP && isValidIP(cfIP)) {
    return cfIP
  }

  // 直接连接
  const remoteAddress = req.connection?.remoteAddress || 
                        req.socket?.remoteAddress ||
                        req.ip

  // 处理 IPv6 映射的 IPv4 地址
  if (remoteAddress && remoteAddress.startsWith('::ffff:')) {
    return remoteAddress.substring(7)
  }

  return remoteAddress || 'unknown'
}

/**
 * 验证 IP 地址格式
 */
function isValidIP(ip) {
  if (!ip || typeof ip !== 'string') return false
  
  // IPv4
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/
  if (ipv4Regex.test(ip)) {
    const parts = ip.split('.').map(Number)
    return parts.every(part => part >= 0 && part <= 255)
  }
  
  // IPv6 (简化验证)
  const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/
  return ipv6Regex.test(ip)
}

/**
 * 匿名化 IP 地址（用于日志）
 */
export function anonymizeIP(ip) {
  if (!ip) return 'unknown'
  
  // IPv4: 隐藏最后一段
  if (ip.includes('.')) {
    const parts = ip.split('.')
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.*`
    }
  }
  
  // IPv6: 隐藏后半部分
  if (ip.includes(':')) {
    const parts = ip.split(':')
    if (parts.length > 4) {
      return parts.slice(0, 4).join(':') + ':****'
    }
  }
  
  return ip.substring(0, ip.length / 2) + '****'
}

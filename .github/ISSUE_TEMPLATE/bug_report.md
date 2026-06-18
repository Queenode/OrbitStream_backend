---
name: "Bug Report"
about: "Report a bug in the OrbitStream Backend API"
title: "[BUG] "
labels: ["bug", "needs-triage"]
assignees: ""
---

# Bug Report

## 🔍 Is this a regression?

<!-- Did this work before and now it's broken? If so, which version last worked? -->

## 📝 Description

<!-- A clear and concise description of what the bug is. -->

## 🔄 Steps to Reproduce

1. 
2. 
3. 

## ✅ Expected Behavior

<!-- What you expected to happen. -->

## ❌ Actual Behavior

<!-- What actually happened. Include error messages, stack traces, or screenshots. -->

## 🌍 Environment

- **OS**: [e.g., Ubuntu 22.04, macOS 14]
- **Node.js version**: [e.g., 20.11.0]
- **npm version**: [e.g., 10.2.4]
- **OrbitStream Backend version**: [e.g., commit hash or version tag]
- **Database**: [e.g., PostgreSQL 16]
- **Redis version**: [e.g., 7.2]
- **Stellar network**: [testnet / mainnet]

## 📋 Configuration

<!-- Paste relevant env vars (REDACT secrets like JWT_SECRET, DATABASE_URL passwords). -->

```env
NODE_ENV=
STELLAR_NETWORK=
PORT=
```

## 📦 API Request/Response

<!-- If applicable, paste the curl command or SDK call that triggers the bug. -->

**Request:**
```bash
curl -X POST http://localhost:3001/v1/checkout/sessions \
  -H "Authorization: Bearer sk_test_..." \
  -H "Content-Type: application/json" \
  -d '{ "amount": 25.00, "asset": "USDC" }'
```

**Response:**
```json
{
  "statusCode": 500,
  "message": "Internal server error"
}
```

## 📋 Database State

<!-- If the bug involves data, describe the relevant DB state (without secrets). -->

## 🔍 Logs

<!-- Paste relevant backend logs. Redact sensitive information. -->

```
[Paste logs here]
```

## 🧪 Test Case

<!-- If possible, provide a minimal test case that reproduces the issue. -->

```typescript
// Minimal reproduction
```

## 📎 Additional Context

<!-- Any other context about the problem. Links to related issues, PRs, or docs. -->

## ✅ Checklist

- [ ] I have searched existing issues and this is not a duplicate
- [ ] I am using the latest version of OrbitStream Backend
- [ ] I have included all relevant environment details
- [ ] I have redacted secrets and sensitive information

# Contributing to Stream-ETL

Thank you for your interest in contributing to Stream-ETL! This document provides guidelines and instructions for contributing.

## 🎯 Our Values

- **Simplicity**: Keep it simple and maintainable
- **Performance**: Measure twice, optimize once
- **Reliability**: Tests matter more than features
- **Documentation**: Code should be self-documenting

## 🚀 Getting Started

### 1. Fork & Clone

```bash
git clone https://github.com/YOUR-USERNAME/hotel-sync-etl.git
cd stream-etl
npm install
```

### 2. Create a Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/bug-description
```

**Branch naming:**

- `feature/` - new features
- `fix/` - bug fixes
- `docs/` - documentation
- `perf/` - performance improvements
- `test/` - test additions

### 3. Make Changes

**Code Standards:**

```typescript
// ✅ Good
const processRecords = async (batch: HotelRecord[]): Promise<void> => {
  for (const record of batch) {
    await insertRecord(record);
  }
};

// ❌ Bad
const processRecords = async (batch: any) => {
  for (const record of batch) {
    await insertRecord(record);
  }
};
```

**Requirements:**

- ✅ TypeScript strict mode (no `any` types)
- ✅ Const/let (no `var`)
- ✅ Async/await (no callbacks where possible)
- ✅ Error handling on all promises
- ✅ Meaningful variable names

### 4. Test Your Changes

```bash
# Build
npm run build

# Run tests (if available)
npm test

# Lint
npm run lint

# Type check
npx tsc --noEmit
```

### 5. Commit & Push

**Commit messages:**

```
feat: Add checkpoint resumption support
fix: Correct S3 multipart upload timeout
docs: Update installation guide
perf: Optimize batch insert with prepared statements
test: Add streaming unit tests
```

Format: `type: description` (lowercase, <50 chars)

```bash
git add .
git commit -m "feat: Add DynamoDB checkpointing"
git push origin feature/your-feature-name
```

### 6. Submit Pull Request

**PR Template:**

```markdown
## Description

Brief description of changes

## Motivation & Context

Why is this change needed? What problem does it solve?

## Type of Change

- [ ] New feature
- [ ] Bug fix
- [ ] Performance improvement
- [ ] Documentation update

## Testing

How was this tested?

- [ ] Unit tests added
- [ ] Tested locally
- [ ] Performance benchmarked

## Screenshots (if applicable)

`npm run monitor` output, logs, etc.

## Checklist

- [ ] Code follows style guidelines
- [ ] TypeScript strict mode passes
- [ ] No `any` types added
- [ ] Comments added for complex logic
- [ ] Documentation updated
- [ ] Tests pass locally
```

---

## 📋 Code Review Checklist

Your PR will be reviewed for:

- ✅ **Correctness** - Does it actually solve the problem?
- ✅ **Performance** - Is it efficient? Benchmark if needed
- ✅ **Readability** - Can others understand this code?
- ✅ **Tests** - Are edge cases covered?
- ✅ **Documentation** - Is it explained?
- ✅ **Security** - Are there vulnerabilities?
- ✅ **Compatibility** - Does it break existing features?

---

## 🐛 Reporting Bugs

**Found a bug?**

1. Check [existing issues](https://github.com/yourusername/stream-etl/issues)
2. If not found, create a new issue with:

```markdown
**Describe the bug**
A clear description of what happened

**To Reproduce**

1. npm install
2. Set env variables
3. npm run pipeline
4. Error occurs

**Expected behavior**
What should have happened

**Environment**

- Node.js version: 18.x
- OS: macOS/Linux/Windows
- Database: PostgreSQL 13+

**Logs**
```

[paste error logs here]

```

**Additional context**
Anything else relevant?
```

---

## 💡 Feature Requests

Want a new feature?

1. Check [discussions](https://github.com/yourusername/stream-etl/discussions)
2. Create an issue with:

```markdown
**Is your feature request related to a problem?**
Description of use case

**Proposed Solution**
How should this work?

**Alternatives Considered**
Other approaches?

**Additional Context**
Examples, related issues, docs links
```

---

## 📚 Documentation

### Adding/Updating Docs

```bash
# Docs live in /docs folder
docs/
├── SETUP.md          # Installation guide
├── ARCHITECTURE.md   # System design
├── API.md           # API reference
└── TROUBLESHOOTING.md
```

**When to update docs:**

- New feature added
- API changes
- Workflow changes
- New troubleshooting case

### Format

```markdown
## Section Title

Short description.

### Subsection

Code example:
\`\`\`typescript
example code
\`\`\`

### Related Links

- [Internal link](docs/other.md)
- [External link](https://example.com)
```

---

## 🏃 Development Workflow

### Watch Mode

```bash
# Rebuild on changes
npm run build -- --watch
```

### Run Locally

```bash
# Full pipeline in dev
npm run pipeline

# Monitor in another terminal
npm run monitor

# Manual S3 operations
aws s3 ls s3://your-bucket/
```

### Database Connection

```bash
# Test connection
npm run test:db

# View logs
tail -f pipeline_run.log

# Query database
psql postgresql://user:pass@host:port/db
```

---

## 🔒 Security

### Reporting Security Issues

**Do NOT open a public issue for security vulnerabilities!**

Email: security@yourdomain.com

Include:

- Vulnerability description
- Steps to reproduce
- Impact assessment
- Suggested fix (if known)

---

## 📖 Architecture Notes

Before contributing, understand:

1. **Streaming Architecture** - Data flows through Node.js Transform streams
2. **S3 Multipart Upload** - Uses AWS SDK v3 Upload class (not PutObjectCommand)
3. **Connection Pooling** - PostgreSQL pool maintained by pg-pool
4. **Error Handling** - Always throw, catch at service level
5. **Type Safety** - Strict TypeScript, no escape hatches

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for details

---

## 🚀 Release Process

Maintainers only:

```bash
# Update version
npm version patch|minor|major

# Publish
npm publish

# Create GitHub release
# Tag: v1.0.0
# Release notes: [changelog](CHANGELOG.md)
```

---

## 📞 Questions?

- **Discussions**: [GitHub Discussions](https://github.com/yourusername/stream-etl/discussions)
- **Issues**: [GitHub Issues](https://github.com/yourusername/stream-etl/issues)
- **Email**: dev@yourdomain.com

---

## 🙏 Thank You!

Every contribution helps. Whether it's code, tests, docs, or bug reports—thank you for making Stream-ETL better!

---

**Happy coding! 🎉**

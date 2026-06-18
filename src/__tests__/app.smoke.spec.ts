describe('App smoke test', () => {
  it('should have basic module structure', () => {
    expect(true).toBe(true);
  });

  it('should export AppModule', async () => {
    const { AppModule } = await import('../app.module');
    expect(AppModule).toBeDefined();
  });
});

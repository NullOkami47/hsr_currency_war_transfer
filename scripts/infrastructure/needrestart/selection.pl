#!/usr/bin/perl
use strict;
use warnings;
use JSON::PP;
use Data::Dumper;
use File::Basename qw(dirname);

# No path or Perl source arguments. The caller checks root ownership and all
# ancestors before invocation. Only administrator-controlled fixed config runs.
die "No arguments permitted\n" if @ARGV;
our (%nrconf, $LOGPREF);
$LOGPREF = '[hsr-needrestart-check]';
my $destination = '/etc/needrestart/conf.d/99-hsr-worker-production.conf';
my $fragment_path = dirname(__FILE__) . '/99-hsr-worker-production.conf';

sub slurp {
    my ($path) = @_;
    open my $fh, '<', $path or die "Cannot read $path: $!\n";
    local $/;
    my $data = <$fh>;
    close $fh or die "Cannot close $path: $!\n";
    return $data;
}
sub evaluate {
    my ($source) = @_;
    # Deliberately match the installed program's Perl eval, including %nrconf.
    eval $source;
    die "Configuration evaluation failed: $@" if $@;
}
sub canonical {
    return Data::Dumper->new([$_[0]])->Sortkeys(1)->Terse(1)->Indent(0)->Dump;
}

my $installed = slurp('/usr/sbin/needrestart');
my ($defaults) = $installed =~ /^(our %nrconf = \(\n.*?^\);)/ms;
die "Unsupported needrestart defaults\n" unless defined $defaults;
# Use the actual installed automatic/list selection stanza. Never execute the
# program, its restart_cmd, scanner, UI, APT hook or any systemctl command.
my $expected_selection = <<'SELECTION';
my $restart = !$nrconf{defno};
# Default to defer restarting the service that called needrestart,
# as it could result in needrestart committing suicide.
$restart = 0 if ($self_unit =~ /${rc}$/);
foreach my $re (keys %{$nrconf{override_rc}}) {
next unless($rc =~ /$re/);
$restart = $nrconf{override_rc}->{$re};
last;
}
SELECTION
my ($selection) = $installed =~ /(my \$restart = !\$nrconf\{defno\};.*?)(?=\s*# \.\.\.but complain about them)/s;
my $normalise = sub { my $text = shift; $text =~ s/^\h+//mg; $text =~ s/\n\s*\n/\n/g; $text =~ s/\A\s+//; $text =~ s/\s+\z//; return $text; };
die "Unsupported needrestart selection implementation\n"
    unless defined($selection) && $normalise->($selection) eq $normalise->($expected_selection);
my $select = eval 'sub { my ($rc, $self_unit) = @_; ' . $selection . '; return $restart ? 1 : 0; }';
die "Invalid selection stanza: $@" if $@;

my $main = slurp('/etc/needrestart/needrestart.conf');
# The stock loader evaluates sorted conf.d entries. Split that exact supported
# trailer so a candidate is evaluated at its REAL lexical position, including
# any later snippets. Refuse a customised loader rather than guess its effects.
my $loader = <<'LOADER';
if(-d q(/etc/needrestart/conf.d)) {
      foreach my $fn (sort </etc/needrestart/conf.d/*.conf>) {
	      print STDERR "$LOGPREF eval $fn\n" if($nrconf{verbosity} > 1);
	      eval do { local(@ARGV, $/) = $fn; <>};
	      die "Error parsing $fn: $@" if($@);
      }
}
LOADER
my $marker = '# Read additional config snippets.';
my $offset = rindex($main, $marker);
die "Unsupported needrestart conf.d loader\n" if $offset < 0;
my $tail = substr($main, $offset + length($marker));
die "Unsupported needrestart conf.d loader\n" unless $normalise->($tail) eq $normalise->($loader);
my $body = substr($main, 0, $offset);
my %fragments = map { $_ => slurp($_) } glob('/etc/needrestart/conf.d/*.conf');
my $candidate = slurp($fragment_path);
my @names = (
    'hsr-worker-production.service', 'hsr-worker-staging.service',
    'hsr-worker-productionXservice', 'prefix-hsr-worker-production.service',
    'hsr-worker-production.service-extra', "hsr-worker-production.service\n",
    'hsr-worker-production@one.service', 'hsr-worker-production',
    'ssh.service', 'cron.service', 'caddy.service', 'dbus.service',
    'apt-daily-upgrade.service', 'unattended-upgrades.service',
);
sub configuration {
    my ($include_candidate) = @_;
    evaluate($defaults);
    evaluate($body);
    my %sources = %fragments;
    $sources{$destination} = $candidate if $include_candidate;
    evaluate($sources{$_}) for sort keys %sources;
    die "override_rc is not a hash\n" unless ref($nrconf{override_rc}) eq 'HASH';
    my %overrides = %{$nrconf{override_rc}};
    my %other = %nrconf;
    delete $other{override_rc};
    my @rows;
    for my $rc (@names) {
        my @matching = sort grep { $rc =~ /$_/ } keys %overrides;
        push @rows, { service => $rc, selected => $select->($rc, ''),
            matches => [map { { pattern => $_, value => $overrides{$_} ? 1 : 0 } } @matching] };
    }
    return { overrides => \%overrides, other => canonical(\%other), rows => \@rows };
}
my $before = configuration(0);
my $after = configuration(1);
my $key = '' . qr(\Ahsr-worker-production\.service\z);
for my $pattern (keys %{$before->{overrides}}) {
    die "Existing override changed\n" unless exists($after->{overrides}->{$pattern})
        && canonical($before->{overrides}->{$pattern}) eq canonical($after->{overrides}->{$pattern});
}
my @added = grep { !exists $before->{overrides}->{$_} } keys %{$after->{overrides}};
die "Candidate changed unrelated overrides\n" if grep { $_ ne $key } @added;
die "Candidate changed other configuration\n" unless $before->{other} eq $after->{other};
die "Candidate does not survive sorted loading\n" unless exists($after->{overrides}->{$key})
    && !$after->{overrides}->{$key};
my $target = $after->{rows}->[0];
die "Target remains selected or has conflicting overrides\n"
    if $target->{selected} || !@{$target->{matches}} || grep { $_->{value} } @{$target->{matches}};
die "Target is blacklisted rather than deferred\n"
    if grep { $names[0] =~ /$_/ } @{$nrconf{blacklist_rc}};
for my $index (1 .. $#names) {
    die "Unrelated service selection changed\n"
        unless canonical($before->{rows}->[$index]) eq canonical($after->{rows}->[$index]);
}
print JSON::PP->new->canonical->encode({
    exactOnly => JSON::PP::true, candidateKey => $key,
    before => $before->{rows}, after => $after->{rows},
    existingOverridesPreserved => JSON::PP::true,
    nonServiceConfigurationPreserved => JSON::PP::true,
    selectionSource => 'installed /usr/sbin/needrestart automatic/list selection stanza',
}), "\n";
